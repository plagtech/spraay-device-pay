import { formatUnits } from 'viem';
import { DevicePayError } from './errors.js';

export const USDC_DECIMALS = 6;

/**
 * Converts a decimal USDC string such as `"1.50"` to atomic units.
 *
 * Input with more than six decimal places is rejected rather than rounded, so a configured limit
 * always means exactly what was written.
 */
export function parseUsdc(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) {
    throw new DevicePayError(`Invalid USDC amount: ${JSON.stringify(value)}`);
  }
  const fraction = (match[2] ?? '').padEnd(USDC_DECIMALS, '0');
  return BigInt(`${match[1]}${fraction}`);
}

/** Converts atomic USDC units to a decimal string. */
export function formatUsdc(atomic: bigint): string {
  return formatUnits(atomic, USDC_DECIMALS);
}
