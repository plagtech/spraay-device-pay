/**
 * Minimal x402 payment on Base Sepolia.
 *
 * Usage: DEVICE_PAY_PRIVATE_KEY=0x... X402_URL=https://... pnpm exec tsx examples/basic-payment.ts
 */
import { BASE_SEPOLIA_CHAIN_ID, DevicePayClient, LocalSigner, PolicyEngine } from '../src/index.js';

const url = process.env.X402_URL;
if (!url) throw new Error('Set X402_URL to an x402-protected endpoint');

// Payments are denied unless a policy is active.
const policyEngine = new PolicyEngine();
await policyEngine.addPolicy({ maxPerTransactionUsdc: '0.10' });

const client = new DevicePayClient({
  signer: LocalSigner.fromEnv(),
  policyEngine,
  chainIds: [BASE_SEPOLIA_CHAIN_ID],
});

const access = await client.requestAccess(url);

if (!access.paymentRequired) {
  console.log('No payment needed:', await access.response.text());
} else {
  const payment = await client.constructPayment(access.paymentRequired);
  console.log(`Paying ${payment.amount} USDC`);

  const result = await client.executePayment(access.paymentRequired.url, payment);
  console.log(`Status: ${result.status}`, result.txHash ?? result.error ?? '');
  console.log(await result.response.text());
}
