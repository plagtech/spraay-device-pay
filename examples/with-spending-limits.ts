/**
 * Payment guarded by spending limits, a service allowlist, and terminal approval.
 *
 * Usage: DEVICE_PAY_PRIVATE_KEY=0x... X402_URL=https://... pnpm exec tsx examples/with-spending-limits.ts
 */
import {
  BASE_SEPOLIA_CHAIN_ID,
  CLIDeviceAdapter,
  DevicePayClient,
  LocalSigner,
  PaymentDeniedError,
  PolicyEngine,
  SpendingPolicy,
} from '../src/index.js';

const url = process.env.X402_URL;
if (!url) throw new Error('Set X402_URL to an x402-protected endpoint');

const policyEngine = new PolicyEngine();
await policyEngine.addPolicy(
  new SpendingPolicy({
    name: 'Everyday assistant budget',
    maxPerTransactionUsdc: '1.00',
    periodLimits: [
      { period: 'hour', maxUsdc: '2.00' },
      { period: 'day', maxUsdc: '5.00' },
      { period: 'month', maxUsdc: '25.00' },
    ],
    allowlist: [new URL(url).hostname],
    blocklist: ['*.untrusted.example'],
    approvalThresholdUsdc: '0.25',
  }),
);

const client = new DevicePayClient({
  signer: LocalSigner.fromEnv(),
  policyEngine,
  chainIds: [BASE_SEPOLIA_CHAIN_ID],
  adapter: new CLIDeviceAdapter(),
});

try {
  const access = await client.requestAccess(url);
  if (access.paymentRequired) {
    const payment = await client.constructPayment(access.paymentRequired);
    const result = await client.executePayment(access.paymentRequired.url, payment);
    console.log(await result.response.text());
  }
} catch (error) {
  if (!(error instanceof PaymentDeniedError)) throw error;
  console.error('Denied:', error.evaluation.reasons.map((reason) => reason.code).join(', '));
}

console.table(
  (await client.logger.list()).map(({ timestamp, url, amount, status, txHash }) => ({
    timestamp,
    url,
    amount,
    status,
    txHash,
  })),
);
