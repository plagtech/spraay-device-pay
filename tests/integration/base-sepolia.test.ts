import { createPublicClient, http, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../src/auth/policy-engine.js';
import { BASE_SEPOLIA_CHAIN_ID } from '../../src/networks.js';
import { DevicePayClient } from '../../src/payer/device-pay-client.js';
import { LocalSigner } from '../../src/wallet/local-signer.js';

const KEY_ENV = 'DEVICE_PAY_TESTNET_PRIVATE_KEY';
const url = process.env.DEVICE_PAY_TESTNET_URL;
const configured = Boolean(process.env[KEY_ENV] && url);

/**
 * Pays a real x402 endpoint with testnet USDC. Requires a dev wallet funded with Base Sepolia USDC
 * and an endpoint that accepts payment on Base Sepolia.
 */
describe.skipIf(!configured)('Base Sepolia settlement', () => {
  it('pays an x402 endpoint and settles on-chain', async () => {
    const policyEngine = new PolicyEngine();
    await policyEngine.addPolicy({
      name: 'integration test cap',
      maxPerTransactionUsdc: '0.10',
      periodLimits: [{ period: 'hour', maxUsdc: '0.10' }],
    });
    const client = new DevicePayClient({
      signer: LocalSigner.fromEnv(KEY_ENV),
      policyEngine,
      chainIds: [BASE_SEPOLIA_CHAIN_ID],
    });

    const access = await client.requestAccess(url as string);
    expect(access.response.status).toBe(402);
    expect(access.paymentRequired).not.toBeNull();

    const challenge = access.paymentRequired as NonNullable<typeof access.paymentRequired>;
    const payment = await client.constructPayment(challenge);
    const result = await client.executePayment(challenge.url, payment);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('settled');
    expect(result.response.ok).toBe(true);

    const chain = createPublicClient({ chain: baseSepolia, transport: http() });
    const receipt = await chain.waitForTransactionReceipt({ hash: result.txHash as Hex });
    expect(receipt.status).toBe('success');

    const [record] = await client.logger.list();
    expect(record).toMatchObject({ status: 'settled', txHash: result.txHash });
  });
});
