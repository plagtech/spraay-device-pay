import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { generatePrivateKey } from 'viem/accounts';
import { PolicyEngine } from '../src/auth/policy-engine.js';
import type { SpendingPolicyConfig } from '../src/auth/spending-policy.js';
import { BASE_SEPOLIA_CHAIN_ID, USDC_ADDRESSES } from '../src/networks.js';
import { LocalSigner } from '../src/wallet/local-signer.js';

export const RESOURCE_URL = 'https://api.example.com/v1/data';
export const SEPOLIA = `eip155:${BASE_SEPOLIA_CHAIN_ID}` as const;
export const PAY_TO = '0x1111111111111111111111111111111111111111';
export const TX_HASH = `0x${'ab'.repeat(32)}`;

/** Creates a signer with a random key generated for this test run. */
export function testSigner(): LocalSigner {
  return new LocalSigner(generatePrivateKey());
}

export function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: SEPOLIA,
    asset: USDC_ADDRESSES[BASE_SEPOLIA_CHAIN_ID],
    amount: '100000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  };
}

export function paymentRequired(
  accepts: PaymentRequirements[] = [requirement()],
  overrides: Partial<PaymentRequired> = {},
): PaymentRequired {
  return { x402Version: 2, resource: { url: RESOURCE_URL }, accepts, ...overrides };
}

export function challengeResponse(required: PaymentRequired = paymentRequired()): Response {
  return new Response('{}', {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) },
  });
}

export function settledResponse(overrides: Partial<SettleResponse> = {}): Response {
  const settlement: SettleResponse = {
    success: true,
    transaction: TX_HASH,
    network: SEPOLIA,
    ...overrides,
  };
  return new Response('{"data":"paid content"}', {
    status: 200,
    headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settlement) },
  });
}

export async function engineWith(...policies: SpendingPolicyConfig[]): Promise<PolicyEngine> {
  const engine = new PolicyEngine();
  for (const policy of policies) {
    await engine.addPolicy(policy);
  }
  return engine;
}
