import { decodePaymentSignatureHeader } from '@x402/core/http';
import { getDefaultAsset } from '@x402/evm';
import { verifyTypedData } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { MockDeviceAdapter } from '../src/adapters/mock-device-adapter.js';
import { DeviceAdapter } from '../src/adapters/device-adapter.js';
import type { SpendingPolicyConfig } from '../src/auth/spending-policy.js';
import { InvalidChallengeError, PaymentDeniedError, PaymentExecutionError } from '../src/errors.js';
import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, USDC_ADDRESSES } from '../src/networks.js';
import { selectRequirement } from '../src/payer/challenge.js';
import {
  DevicePayClient,
  type DevicePayClientConfig,
  type PaymentChallenge,
} from '../src/payer/device-pay-client.js';
import {
  challengeResponse,
  engineWith,
  PAY_TO,
  paymentRequired,
  requirement,
  RESOURCE_URL,
  SEPOLIA,
  settledResponse,
  testSigner,
  TX_HASH,
} from './helpers.js';

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

async function setup(
  policy: SpendingPolicyConfig = { maxPerTransactionUsdc: '1' },
  config: Partial<DevicePayClientConfig> = {},
) {
  const signer = testSigner();
  const policyEngine = await engineWith(policy);
  const fetch: FetchMock = vi.fn<typeof globalThis.fetch>();
  const client = new DevicePayClient({
    signer,
    policyEngine,
    chainIds: [BASE_SEPOLIA_CHAIN_ID],
    fetch,
    ...config,
  });
  return { client, fetch, policyEngine, signer };
}

const challenge = (overrides: Partial<PaymentChallenge> = {}): PaymentChallenge => ({
  url: RESOURCE_URL,
  required: paymentRequired(),
  ...overrides,
});

const statuses = async (client: DevicePayClient) =>
  (await client.logger.list()).map((record) => record.status);

describe('USDC configuration', () => {
  it.each([
    [BASE_MAINNET_CHAIN_ID, 'eip155:8453'],
    [BASE_SEPOLIA_CHAIN_ID, 'eip155:84532'],
  ] as const)('matches the upstream asset for chain %d', (chainId, network) => {
    expect(USDC_ADDRESSES[chainId]).toBe(getDefaultAsset(network, 'USDC').asset);
  });
});

describe('selectRequirement', () => {
  const sepolia = [BASE_SEPOLIA_CHAIN_ID] as const;

  it.each([
    ['another network', { network: 'eip155:1' as const }],
    ['another token', { asset: '0x2222222222222222222222222222222222222222' }],
    ['another scheme', { scheme: 'upto' }],
    ['a zero amount', { amount: '0' }],
    ['a malformed amount', { amount: '1.5' }],
  ])('ignores %s', (_label, overrides) => {
    expect(selectRequirement(paymentRequired([requirement(overrides)]), sepolia)).toBeUndefined();
  });

  it('picks the lowest price', () => {
    const cheap = requirement({ amount: '5' });
    const required = paymentRequired([requirement({ amount: '10' }), cheap]);
    expect(selectRequirement(required, sepolia)).toEqual(cheap);
  });

  it('prefers the chain listed first, even at a higher price', () => {
    const mainnet = requirement({
      network: 'eip155:8453',
      asset: USDC_ADDRESSES[BASE_MAINNET_CHAIN_ID],
      amount: '1',
    });
    const testnet = requirement({ amount: '2' });
    expect(
      selectRequirement(paymentRequired([mainnet, testnet]), [
        BASE_SEPOLIA_CHAIN_ID,
        BASE_MAINNET_CHAIN_ID,
      ]),
    ).toEqual(testnet);
  });
});

describe('requestAccess', () => {
  it('passes through a response that needs no payment', async () => {
    const { client, fetch } = await setup();
    fetch.mockResolvedValue(new Response('free'));
    const result = await client.requestAccess(RESOURCE_URL);
    expect(result.paymentRequired).toBeNull();
    expect(await result.response.text()).toBe('free');
  });

  it('parses a v2 challenge from the PAYMENT-REQUIRED header', async () => {
    const { client, fetch } = await setup();
    fetch.mockResolvedValue(challengeResponse());
    const { paymentRequired: parsed } = await client.requestAccess(RESOURCE_URL);
    expect(parsed?.url).toBe(RESOURCE_URL);
    expect(parsed?.required.accepts).toEqual([requirement()]);
  });

  it('binds the challenge to the final URL after a redirect', async () => {
    const { client, fetch } = await setup();
    const response = challengeResponse();
    Object.defineProperty(response, 'url', { value: 'https://other.example.net/pay' });
    fetch.mockResolvedValue(response);
    const { paymentRequired: parsed } = await client.requestAccess(RESOURCE_URL);
    expect(parsed?.url).toBe('https://other.example.net/pay');
  });

  it('rejects a 402 without a valid challenge', async () => {
    const { client, fetch } = await setup();
    fetch.mockResolvedValue(new Response('{}', { status: 402 }));
    await expect(client.requestAccess(RESOURCE_URL)).rejects.toThrow(InvalidChallengeError);
  });

  it('rejects x402 v1 challenges', async () => {
    const { client, fetch } = await setup();
    fetch.mockResolvedValue(challengeResponse(paymentRequired([], { x402Version: 1 })));
    await expect(client.requestAccess(RESOURCE_URL)).rejects.toThrow(InvalidChallengeError);
  });
});

describe('constructPayment', () => {
  it('produces a valid EIP-3009 signature for Base Sepolia USDC', async () => {
    const { client, signer } = await setup();
    const { payload } = await client.constructPayment(challenge());
    const { authorization, signature } = payload.payload as {
      authorization: {
        from: `0x${string}`;
        to: `0x${string}`;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: `0x${string}`;
      };
      signature: `0x${string}`;
    };

    expect(payload.x402Version).toBe(2);
    expect(authorization.from).toBe(signer.address);
    expect(authorization.to).toBe(PAY_TO);
    expect(authorization.value).toBe('100000');
    await expect(
      verifyTypedData({
        address: signer.address,
        domain: {
          name: 'USDC',
          version: '2',
          chainId: BASE_SEPOLIA_CHAIN_ID,
          verifyingContract: USDC_ADDRESSES[BASE_SEPOLIA_CHAIN_ID],
        },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          ...authorization,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
        },
        signature,
      }),
    ).resolves.toBe(true);
  });

  it('allows payments above the upstream default $1 cap when policy permits', async () => {
    const { client } = await setup({ maxPerTransactionUsdc: '5' });
    const required = paymentRequired([requirement({ amount: '2500000' })]);
    await expect(client.constructPayment(challenge({ required }))).resolves.toMatchObject({
      amount: '2.5',
    });
  });

  it('refuses to sign over the limit and logs the denial', async () => {
    const signer = testSigner();
    const sign = vi.spyOn(signer, 'signTypedData');
    const { client } = await setup({ maxPerTransactionUsdc: '0.01' }, { signer });

    await expect(client.constructPayment(challenge())).rejects.toThrow(PaymentDeniedError);
    expect(sign).not.toHaveBeenCalled();
    const [record] = await client.logger.list();
    expect(record).toMatchObject({ status: 'denied', amount: '0.1', url: RESOURCE_URL });
    expect(record?.policyEvaluation.reasons[0]?.code).toBe('PER_TRANSACTION_LIMIT');
  });

  it('applies the allowlist to the real URL, not the server-claimed resource', async () => {
    const { client } = await setup({ allowlist: ['trusted.example.com'] });
    const required = paymentRequired([requirement()], {
      resource: { url: 'https://trusted.example.com/claimed' },
    });
    await expect(
      client.constructPayment(challenge({ url: 'https://evil.example.net/x', required })),
    ).rejects.toThrow(PaymentDeniedError);
  });

  it('logs a denial when no option is supported', async () => {
    const { client } = await setup();
    const required = paymentRequired([requirement({ network: 'eip155:1' })]);
    const error = await client.constructPayment(challenge({ required })).catch((e: unknown) => e);
    expect((error as PaymentDeniedError).evaluation.reasons[0]?.code).toBe(
      'NO_SUPPORTED_REQUIREMENT',
    );
    expect(await statuses(client)).toEqual(['denied']);
  });

  describe('approval', () => {
    const policy = {
      approvalThresholdUsdc: '0.01',
      periodLimits: [{ period: 'day', maxUsdc: '0.1' }],
    } as const;
    const limited: SpendingPolicyConfig = { ...policy, periodLimits: [...policy.periodLimits] };

    it('signs after the user approves', async () => {
      const adapter = new MockDeviceAdapter();
      const { client } = await setup(limited, { adapter });
      const payment = await client.constructPayment(challenge());

      expect(adapter.approvalRequests).toHaveLength(1);
      expect(adapter.approvalRequests[0]).toMatchObject({ amount: '0.1', payTo: PAY_TO });
      expect(payment.evaluation.userApproval).toBe('approved');
      expect(adapter.statusUpdates.map((update) => update.status)).toEqual([
        'awaiting_approval',
        'approved',
      ]);
    });

    it('denies and restores the budget when the user declines', async () => {
      const adapter = new MockDeviceAdapter({ approve: false });
      const { client, policyEngine } = await setup(limited, { adapter });
      const error = await client.constructPayment(challenge()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PaymentDeniedError);
      expect((error as PaymentDeniedError).evaluation.userApproval).toBe('denied');
      expect(await statuses(client)).toEqual(['denied']);
      const evaluation = await policyEngine.evaluate({
        url: RESOURCE_URL,
        amount: 100000n,
        network: SEPOLIA,
        payTo: PAY_TO,
      });
      expect(evaluation.decision).toBe('require_approval');
    });

    it('denies when no adapter is configured', async () => {
      const { client } = await setup(limited);
      await expect(client.constructPayment(challenge())).rejects.toThrow(PaymentDeniedError);
    });

    it('denies when the adapter throws', async () => {
      const adapter = new MockDeviceAdapter();
      vi.spyOn(adapter, 'requestUserApproval').mockRejectedValue(new Error('no screen'));
      const { client } = await setup(limited, { adapter });
      await expect(client.constructPayment(challenge())).rejects.toThrow(PaymentDeniedError);
    });

    it('denies a truthy answer that is not exactly true', async () => {
      const adapter = new MockDeviceAdapter();
      vi.spyOn(adapter, 'requestUserApproval').mockResolvedValue('yes' as unknown as boolean);
      const { client } = await setup(limited, { adapter });
      await expect(client.constructPayment(challenge())).rejects.toThrow(PaymentDeniedError);
    });

    it('denies and aborts the prompt when approval times out', async () => {
      let signal: AbortSignal | undefined;
      class SilentAdapter extends DeviceAdapter {
        override requestUserApproval(request: { signal?: AbortSignal }): Promise<boolean> {
          signal = request.signal;
          return new Promise(() => undefined);
        }
        override async displayPaymentStatus(): Promise<void> {}
        override async getVoiceCommand(): Promise<null> {
          return null;
        }
      }
      const { client } = await setup(limited, {
        adapter: new SilentAdapter(),
        approvalTimeoutMs: 5,
      });
      await expect(client.constructPayment(challenge())).rejects.toThrow(PaymentDeniedError);
      expect(signal?.aborted).toBe(true);
    });
  });

  it('restores the budget and logs failure when signing fails', async () => {
    const signer = testSigner();
    vi.spyOn(signer, 'signTypedData').mockRejectedValue(new Error('secure element locked'));
    const { client, policyEngine } = await setup(
      { periodLimits: [{ period: 'day', maxUsdc: '0.1' }] },
      { signer },
    );

    await expect(client.constructPayment(challenge())).rejects.toThrow('secure element locked');
    expect(await statuses(client)).toEqual(['failed']);
    const evaluation = await policyEngine.evaluate({
      url: RESOURCE_URL,
      amount: 100000n,
      network: SEPOLIA,
      payTo: PAY_TO,
    });
    expect(evaluation.decision).toBe('allow');
  });

  it('does not sign when the audit log is unavailable', async () => {
    const signer = testSigner();
    const sign = vi.spyOn(signer, 'signTypedData');
    const { client } = await setup({ maxPerTransactionUsdc: '1' }, { signer });
    vi.spyOn(client.logger, 'record').mockRejectedValue(new Error('log offline'));

    await expect(client.constructPayment(challenge())).rejects.toThrow('log offline');
    expect(sign).not.toHaveBeenCalled();
  });

  it('keeps going if the device display fails', async () => {
    const adapter = new MockDeviceAdapter();
    vi.spyOn(adapter, 'displayPaymentStatus').mockRejectedValue(new Error('display off'));
    const { client } = await setup({ maxPerTransactionUsdc: '1' }, { adapter });
    await expect(client.constructPayment(challenge())).resolves.toBeDefined();
  });
});

describe('executePayment', () => {
  it('retries with PAYMENT-SIGNATURE and records the settlement', async () => {
    const { client, fetch } = await setup();
    const payment = await client.constructPayment(challenge());
    fetch.mockResolvedValue(settledResponse());

    const result = await client.executePayment(RESOURCE_URL, payment);

    expect(result).toMatchObject({ status: 'settled', txHash: TX_HASH });
    expect(await result.response.json()).toEqual({ data: 'paid content' });
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('manual');
    const header = new Headers(init.headers).get('PAYMENT-SIGNATURE') as string;
    expect(decodePaymentSignatureHeader(header)).toEqual(payment.payload);

    const [record] = await client.logger.list();
    expect(record).toMatchObject({ status: 'settled', txHash: TX_HASH, amount: '0.1' });
    expect(record?.policyEvaluation.decision).toBe('allow');
  });

  it('reuses the original request options and keeps its headers', async () => {
    const { client, fetch } = await setup();
    const init = { method: 'POST', body: '{"q":1}', headers: { 'x-app': 'demo' } };
    const payment = await client.constructPayment(challenge({ init }));
    fetch.mockResolvedValue(settledResponse());

    await client.executePayment(RESOURCE_URL, payment);

    const [, sent] = fetch.mock.calls[0] as [string, RequestInit];
    expect(sent).toMatchObject({ method: 'POST', body: '{"q":1}' });
    expect(new Headers(sent.headers).get('x-app')).toBe('demo');
  });

  it('rejects a second use of the same payment', async () => {
    const { client, fetch } = await setup();
    const payment = await client.constructPayment(challenge());
    fetch.mockImplementation(async () => settledResponse());
    await client.executePayment(RESOURCE_URL, payment);

    await expect(client.executePayment(RESOURCE_URL, payment)).rejects.toThrow(
      PaymentExecutionError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses to send a payment to a different URL', async () => {
    const { client, fetch } = await setup();
    const payment = await client.constructPayment(challenge());
    await expect(client.executePayment('https://evil.example.net/', payment)).rejects.toThrow(
      PaymentExecutionError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a payment object it did not create', async () => {
    const { client } = await setup();
    const other = await setup();
    const payment = await other.client.constructPayment(challenge());
    await expect(client.executePayment(RESOURCE_URL, payment)).rejects.toThrow(
      PaymentExecutionError,
    );
  });

  it('ignores tampering with the payment object', async () => {
    const { client, fetch } = await setup();
    const payment = await client.constructPayment(challenge());
    const original = structuredClone(payment.payload);
    fetch.mockResolvedValue(settledResponse());

    await client.executePayment(RESOURCE_URL, {
      ...payment,
      payload: { ...original, payload: {} },
    });

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const header = new Headers(init.headers).get('PAYMENT-SIGNATURE') as string;
    expect(decodePaymentSignatureHeader(header)).toEqual(original);
  });

  describe('once the signature has been sent', () => {
    const limit: SpendingPolicyConfig = { periodLimits: [{ period: 'day', maxUsdc: '0.1' }] };
    const remaining = (engine: Awaited<ReturnType<typeof setup>>['policyEngine']) =>
      engine.evaluate({ url: RESOURCE_URL, amount: 1n, network: SEPOLIA, payTo: PAY_TO });

    it.each([
      ['a 402 retry', () => challengeResponse()],
      ['a failed settlement', () => settledResponse({ success: false, errorReason: 'nonce_used' })],
      ['a success without a receipt', () => new Response('ok')],
      ['a server error', () => new Response('boom', { status: 500 })],
    ])('marks %s failed and keeps counting the spend', async (_label, reply) => {
      const { client, fetch, policyEngine } = await setup(limit);
      const payment = await client.constructPayment(challenge());
      fetch.mockResolvedValue(reply());

      const result = await client.executePayment(RESOURCE_URL, payment);

      expect(result.status).toBe('failed');
      expect(result.error).toBeTruthy();
      expect(await statuses(client)).toEqual(['failed']);
      expect((await remaining(policyEngine)).decision).toBe('deny');
    });

    it('throws on a network error and keeps counting the spend', async () => {
      const { client, fetch, policyEngine } = await setup(limit);
      const payment = await client.constructPayment(challenge());
      fetch.mockRejectedValue(new Error('socket hang up'));

      await expect(client.executePayment(RESOURCE_URL, payment)).rejects.toThrow(
        PaymentExecutionError,
      );
      expect(await statuses(client)).toEqual(['failed']);
      expect((await remaining(policyEngine)).decision).toBe('deny');
    });

    it('still returns the settlement if the log update fails', async () => {
      const onLogError = vi.fn();
      const { client, fetch } = await setup({ maxPerTransactionUsdc: '1' }, { onLogError });
      const payment = await client.constructPayment(challenge());
      vi.spyOn(client.logger, 'update').mockRejectedValue(new Error('log offline'));
      fetch.mockResolvedValue(settledResponse());

      await expect(client.executePayment(RESOURCE_URL, payment)).resolves.toMatchObject({
        status: 'settled',
      });
      expect(onLogError).toHaveBeenCalledOnce();
    });
  });

  describe('before the signature is sent', () => {
    const limit: SpendingPolicyConfig = { periodLimits: [{ period: 'day', maxUsdc: '0.1' }] };

    it('releases the budget when cancelled', async () => {
      const { client } = await setup(limit);
      const payment = await client.constructPayment(challenge());
      await client.cancelPayment(payment);

      await expect(client.executePayment(RESOURCE_URL, payment)).rejects.toThrow(
        PaymentExecutionError,
      );
      await expect(client.constructPayment(challenge())).resolves.toBeDefined();
    });

    it('rejects and releases an expired payment', async () => {
      let now = Date.now();
      const { client, fetch } = await setup(limit, { now: () => now });
      const payment = await client.constructPayment(challenge());
      now = payment.expiresAt;

      await expect(client.executePayment(RESOURCE_URL, payment)).rejects.toThrow('expired');
      expect(fetch).not.toHaveBeenCalled();
      expect(await statuses(client)).toEqual(['failed']);
      await expect(client.constructPayment(challenge())).resolves.toBeDefined();
    });

    it('releases abandoned payments on the next construction', async () => {
      let now = Date.now();
      const { client } = await setup(limit, { now: () => now });
      await client.constructPayment(challenge());
      now += 61_000;
      await expect(client.constructPayment(challenge())).resolves.toBeDefined();
    });
  });
});
