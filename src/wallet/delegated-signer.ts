import { randomUUID } from 'node:crypto';
import { isHex, verifyTypedData, type Address, type Hex } from 'viem';
import { DevicePayError, SigningRejectedError, SigningTimeoutError } from '../errors.js';
import type { TypedDataRequest, WalletSigner } from './types.js';

/**
 * JSON-safe signing request. uint256 values that were bigints are decimal strings. The companion
 * app should show the user the decoded recipient, amount, and token before signing.
 */
export interface SigningRequest {
  id: string;
  address: Address;
  typedData: TypedDataRequest;
}

/** Delivers signing requests to the paired wallet. */
export interface SigningTransport {
  /** Resolves with the signature, and throws `SigningRejectedError` if the user declines. */
  requestSignature(request: SigningRequest, signal: AbortSignal): Promise<Hex>;
}

export interface DelegatedSignerOptions {
  /** Address of the wallet held by the paired device. */
  address: Address;
  transport: SigningTransport;
  /** Defaults to two minutes, to leave time for a person to respond on their phone. */
  timeoutMs?: number;
  /**
   * Checks each returned signature against `address` with EOA recovery. Disable only for smart
   * contract wallets, whose signatures cannot be recovered locally. Defaults to true.
   */
  verifySignatures?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as T;
}

/** Forwards signing to a remote wallet, such as a paired phone. The key never reaches the device. */
export class DelegatedSigner implements WalletSigner {
  readonly address: Address;
  readonly #transport: SigningTransport;
  readonly #timeoutMs: number;
  readonly #verifySignatures: boolean;

  constructor(options: DelegatedSignerOptions) {
    this.address = options.address;
    this.#transport = options.transport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#verifySignatures = options.verifySignatures ?? true;
  }

  async signTypedData(request: TypedDataRequest): Promise<Hex> {
    const signature = await this.#requestWithTimeout({
      id: randomUUID(),
      address: this.address,
      typedData: toJsonSafe(request),
    });

    if (!isHex(signature)) {
      throw new DevicePayError('Delegated signer returned a malformed signature');
    }
    if (this.#verifySignatures) {
      const valid = await verifyTypedData({
        ...(request as Parameters<typeof verifyTypedData>[0]),
        address: this.address,
        signature,
      });
      if (!valid) {
        throw new DevicePayError(`Delegated signature was not made by ${this.address}`);
      }
    }
    return signature;
  }

  async #requestWithTimeout(request: SigningRequest): Promise<Hex> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SigningTimeoutError(`No signature within ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([
        this.#transport.requestSignature(request, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface HttpSigningTransportOptions {
  /** Endpoint of your companion service. Must be https unless it is on loopback. */
  url: string;
  /** Extra request headers, such as device credentials. */
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * POSTs the `SigningRequest` as JSON. The service responds 200 with `{ "signature": "0x..." }`, or
 * `{ "rejected": true, "reason"?: string }` if the user declined.
 */
export class HttpSigningTransport implements SigningTransport {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpSigningTransportOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new DevicePayError('Signing endpoint must use https unless it is on loopback');
    }
    this.#url = url.href;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async requestSignature(request: SigningRequest, signal: AbortSignal): Promise<Hex> {
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { ...this.#headers, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      throw new DevicePayError(`Signing service responded with HTTP ${response.status}`);
    }
    const result = (await response.json()) as {
      signature?: Hex;
      rejected?: boolean;
      reason?: string;
    };
    if (result.rejected) {
      throw new SigningRejectedError(result.reason ?? 'User rejected the signing request');
    }
    if (!result.signature) {
      throw new DevicePayError('Signing service response had no signature');
    }
    return result.signature;
  }
}
