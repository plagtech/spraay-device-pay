import type { Address, Hex, PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DevicePayError } from '../errors.js';
import type { TypedDataRequest, WalletSigner } from './types.js';

export const DEFAULT_PRIVATE_KEY_ENV = 'DEVICE_PAY_PRIVATE_KEY';

/** Signs with an in-process private key. Intended for development and testing. */
export class LocalSigner implements WalletSigner {
  readonly #account: PrivateKeyAccount;

  constructor(privateKey: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new DevicePayError('Private key must be 32 bytes of 0x-prefixed hex');
    }
    this.#account = privateKeyToAccount(privateKey as Hex);
  }

  /** Reads the key from an environment variable. */
  static fromEnv(name: string = DEFAULT_PRIVATE_KEY_ENV): LocalSigner {
    const privateKey = process.env[name];
    if (!privateKey) {
      throw new DevicePayError(`Environment variable ${name} is not set`);
    }
    return new LocalSigner(privateKey);
  }

  get address(): Address {
    return this.#account.address;
  }

  signTypedData(request: TypedDataRequest): Promise<Hex> {
    return this.#account.signTypedData(
      request as Parameters<PrivateKeyAccount['signTypedData']>[0],
    );
  }
}
