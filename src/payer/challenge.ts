import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { toCaip2, USDC_ADDRESSES, type SupportedChainId } from '../networks.js';

const ATOMIC_AMOUNT = /^[1-9]\d*$/;

/**
 * Picks the requirement to pay: exact-scheme USDC on an enabled chain, preferring earlier entries
 * in `chainIds` and then the lowest price.
 */
export function selectRequirement(
  paymentRequired: PaymentRequired,
  chainIds: readonly SupportedChainId[],
): PaymentRequirements | undefined {
  const rank = (requirement: PaymentRequirements) =>
    chainIds.findIndex((chainId) => toCaip2(chainId) === requirement.network);

  return paymentRequired.accepts
    .filter((requirement) => {
      const chainId = chainIds.find((id) => toCaip2(id) === requirement.network);
      return (
        chainId !== undefined &&
        requirement.scheme === 'exact' &&
        requirement.asset?.toLowerCase() === USDC_ADDRESSES[chainId].toLowerCase() &&
        ATOMIC_AMOUNT.test(requirement.amount ?? '')
      );
    })
    .sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const difference = BigInt(a.amount) - BigInt(b.amount);
      return difference === 0n ? 0 : difference < 0n ? -1 : 1;
    })[0];
}
