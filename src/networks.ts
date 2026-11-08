import type { Network } from '@x402/core/types';

export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

export type SupportedChainId = typeof BASE_MAINNET_CHAIN_ID | typeof BASE_SEPOLIA_CHAIN_ID;

/**
 * Canonical USDC contracts. These are pinned here rather than read from a 402 response so that a
 * server cannot get the wallet to sign for a different token.
 */
export const USDC_ADDRESSES: Readonly<Record<SupportedChainId, `0x${string}`>> = {
  [BASE_MAINNET_CHAIN_ID]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [BASE_SEPOLIA_CHAIN_ID]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

export function toCaip2(chainId: SupportedChainId): Network {
  return `eip155:${chainId}`;
}
