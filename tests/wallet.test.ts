import type { Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { DevicePayError, SigningRejectedError, SigningTimeoutError } from '../src/errors.js';
import { BASE_SEPOLIA_CHAIN_ID } from '../src/networks.js';
import { DevicePayClient } from '../src/payer/device-pay-client.js';
import {
  DelegatedSigner,
  HttpSigningTransport,
  type SigningRequest,
  type SigningTransport,
} from '../src/wallet/delegated-signer.js';
import { LocalSigner } from '../src/wallet/local-signer.js';
import type { TypedDataRequest } from '../src/wallet/types.js';
import { engineWith, paymentRequired, RESOURCE_URL, testSigner } from './helpers.js';

const typedData: TypedDataRequest = {
  domain: { name: 'Test', version: '1', chainId: BASE_SEPOLIA_CHAIN_ID },
  types: { Note: [{ name: 'value', type: 'uint256' }] },
  primaryType: 'Note',
  message: { value: 123456789012345678901234567890n },
};

/** Simulates a paired phone holding the key. */
function phone(wallet: LocalSigner): SigningTransport & { requests: SigningRequest[] } {
  const requests: SigningRequest[] = [];
  return {
    requests,
    requestSignature: async (request) => {
      requests.push(request);
      return wallet.signTypedData(request.typedData);
    },
  };
}

describe('LocalSigner', () => {
  it('does not reveal the key when the format is wrong', () => {
    const secret = '0xnot-a-real-key';
    expect(() => new LocalSigner(secret)).toThrow(DevicePayError);
    try {
      new LocalSigner(secret);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('reports a missing environment variable', () => {
    expect(() => LocalSigner.fromEnv('DEVICE_PAY_DOES_NOT_EXIST')).toThrow(
      'DEVICE_PAY_DOES_NOT_EXIST',
    );
  });
});

describe('DelegatedSigner', () => {
  it('sends JSON-safe requests and returns a verified signature', async () => {
    const wallet = testSigner();
    const transport = phone(wallet);
    const signer = new DelegatedSigner({ address: wallet.address, transport });

    const signature = await signer.signTypedData(typedData);

    expect(signature).toBe(await wallet.signTypedData(typedData));
    expect(transport.requests[0]?.address).toBe(wallet.address);
    expect(transport.requests[0]?.typedData.message.value).toBe('123456789012345678901234567890');
    expect(() => JSON.stringify(transport.requests[0])).not.toThrow();
  });

  it('rejects a signature from the wrong wallet', async () => {
    const signer = new DelegatedSigner({
      address: testSigner().address,
      transport: phone(testSigner()),
    });
    await expect(signer.signTypedData(typedData)).rejects.toThrow('was not made by');
  });

  it('allows contract-wallet signatures when verification is off', async () => {
    const signature = `0x${'cd'.repeat(90)}` as Hex;
    const signer = new DelegatedSigner({
      address: testSigner().address,
      transport: { requestSignature: async () => signature },
      verifySignatures: false,
    });
    await expect(signer.signTypedData(typedData)).resolves.toBe(signature);
  });

  it('rejects a malformed signature', async () => {
    const signer = new DelegatedSigner({
      address: testSigner().address,
      transport: { requestSignature: async () => 'nope' as Hex },
    });
    await expect(signer.signTypedData(typedData)).rejects.toThrow('malformed');
  });

  it('times out and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const signer = new DelegatedSigner({
      address: testSigner().address,
      timeoutMs: 5,
      transport: {
        requestSignature: (_request, requestSignal) => {
          signal = requestSignal;
          return new Promise(() => undefined);
        },
      },
    });
    await expect(signer.signTypedData(typedData)).rejects.toThrow(SigningTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it('produces payments through the full client flow', async () => {
    const wallet = testSigner();
    const client = new DevicePayClient({
      signer: new DelegatedSigner({ address: wallet.address, transport: phone(wallet) }),
      policyEngine: await engineWith({ maxPerTransactionUsdc: '1' }),
      chainIds: [BASE_SEPOLIA_CHAIN_ID],
    });
    const payment = await client.constructPayment({
      url: RESOURCE_URL,
      required: paymentRequired(),
    });
    expect((payment.payload.payload as { signature: string }).signature).toMatch(/^0x/);
  });
});

describe('HttpSigningTransport', () => {
  const request: SigningRequest = {
    id: '1',
    address: '0x1111111111111111111111111111111111111111',
    typedData,
  };
  const signal = new AbortController().signal;
  const transportFor = (body: unknown, status = 200) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify(body), { status }),
    );
    return {
      fetch,
      transport: new HttpSigningTransport({ url: 'https://phone.test/sign', fetch }),
    };
  };

  it.each(['http://phone.test/sign'])('refuses the insecure endpoint %s', (url) => {
    expect(() => new HttpSigningTransport({ url })).toThrow(DevicePayError);
  });

  it('allows loopback over http', () => {
    expect(() => new HttpSigningTransport({ url: 'http://127.0.0.1:9000/sign' })).not.toThrow();
  });

  it('posts the request and returns the signature', async () => {
    const { fetch, transport } = transportFor({ signature: '0xabc' });
    const safeRequest = { ...request, typedData: { ...typedData, message: { value: '1' } } };
    await expect(transport.requestSignature(safeRequest, signal)).resolves.toBe('0xabc');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://phone.test/sign');
    expect(JSON.parse(init.body as string)).toEqual(safeRequest);
    expect(init.redirect).toBe('error');
  });

  it('surfaces a user rejection', async () => {
    const { transport } = transportFor({ rejected: true, reason: 'Not now' });
    const safeRequest = { ...request, typedData: { ...typedData, message: {} } };
    await expect(transport.requestSignature(safeRequest, signal)).rejects.toThrow(
      SigningRejectedError,
    );
  });

  it('surfaces HTTP errors', async () => {
    const { transport } = transportFor({}, 503);
    const safeRequest = { ...request, typedData: { ...typedData, message: {} } };
    await expect(transport.requestSignature(safeRequest, signal)).rejects.toThrow('503');
  });
});
