import type { Address, Hex } from 'viem';

export interface TypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Signs x402 EIP-712 payment authorizations. */
export interface WalletSigner {
  readonly address: Address;
  signTypedData(request: TypedDataRequest): Promise<Hex>;
}
