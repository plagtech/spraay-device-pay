import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../src/amount.js';
import { PolicyEngine } from '../src/auth/policy-engine.js';
import { InMemoryPolicyStore } from '../src/auth/policy-store.js';
import { SpendingPolicy } from '../src/auth/spending-policy.js';
import type { PaymentContext } from '../src/auth/types.js';
import { DevicePayError } from '../src/errors.js';
import { engineWith, PAY_TO, RESOURCE_URL, SEPOLIA } from './helpers.js';

function context(usdc: string, overrides: Partial<PaymentContext> = {}): PaymentContext {
  return {
    url: RESOURCE_URL,
    amount: parseUsdc(usdc),
    network: SEPOLIA,
    payTo: PAY_TO,
    ...overrides,
  };
}

const codes = (evaluation: { reasons: { code: string }[] }) =>
  evaluation.reasons.map((reason) => reason.code);

describe('PolicyEngine', () => {
  it('denies when no policy is active', async () => {
    const evaluation = await new PolicyEngine().evaluate(context('0.01'));
    expect(evaluation.decision).toBe('deny');
    expect(codes(evaluation)).toEqual(['NO_ACTIVE_POLICY']);
  });

  it('ignores disabled policies', async () => {
    const engine = await engineWith({ enabled: false, maxPerTransactionUsdc: '100' });
    expect((await engine.evaluate(context('0.01'))).decision).toBe('deny');
  });

  describe('per-transaction limit', () => {
    it('allows a payment exactly at the limit', async () => {
      const engine = await engineWith({ maxPerTransactionUsdc: '1.00' });
      expect((await engine.evaluate(context('1'))).decision).toBe('allow');
    });

    it('denies one atomic unit over the limit', async () => {
      const engine = await engineWith({ maxPerTransactionUsdc: '1.00' });
      const evaluation = await engine.evaluate(context('1.000001'));
      expect(evaluation.decision).toBe('deny');
      expect(codes(evaluation)).toEqual(['PER_TRANSACTION_LIMIT']);
    });
  });

  describe('period limits', () => {
    it('counts earlier reservations and allows spending up to the limit', async () => {
      const engine = await engineWith({ periodLimits: [{ period: 'day', maxUsdc: '1' }] });
      expect((await engine.authorize(context('0.60'))).reservationId).toBeDefined();
      expect((await engine.authorize(context('0.40'))).reservationId).toBeDefined();

      const denied = await engine.authorize(context('0.000001'));
      expect(denied.evaluation.decision).toBe('deny');
      expect(denied.reservationId).toBeUndefined();
      expect(codes(denied.evaluation)).toEqual(['PERIOD_LIMIT']);
    });

    it.each([
      ['hour', 3_600_000],
      ['day', 86_400_000],
      ['month', 2_592_000_000],
    ] as const)(
      'frees budget once a spend leaves the rolling %s window',
      async (period, windowMs) => {
        let now = 1_000_000_000_000;
        const engine = new PolicyEngine({ now: () => now });
        await engine.addPolicy({ periodLimits: [{ period, maxUsdc: '1' }] });
        await engine.authorize(context('1'));

        now += windowMs - 1;
        expect((await engine.evaluate(context('0.01'))).decision).toBe('deny');
        now += 1;
        expect((await engine.evaluate(context('0.01'))).decision).toBe('allow');
      },
    );

    it('enforces several periods at once', async () => {
      const engine = await engineWith({
        periodLimits: [
          { period: 'hour', maxUsdc: '5' },
          { period: 'day', maxUsdc: '1' },
        ],
      });
      await engine.authorize(context('1'));
      const evaluation = await engine.evaluate(context('0.5'));
      expect(evaluation.decision).toBe('deny');
      expect(evaluation.reasons).toHaveLength(1);
      expect(evaluation.reasons[0]?.message).toContain('day limit');
    });

    it('tracks each network separately', async () => {
      const engine = await engineWith({ periodLimits: [{ period: 'day', maxUsdc: '1' }] });
      await engine.authorize(context('1'));
      const mainnet = await engine.evaluate(context('1', { network: 'eip155:8453' }));
      expect(mainnet.decision).toBe('allow');
    });

    it('does not let concurrent payments share the same budget', async () => {
      const engine = await engineWith({ periodLimits: [{ period: 'day', maxUsdc: '1' }] });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => engine.authorize(context('0.5'))),
      );
      expect(results.filter((result) => result.reservationId).length).toBe(2);
    });

    it('restores budget when a reservation is released', async () => {
      const engine = await engineWith({ periodLimits: [{ period: 'day', maxUsdc: '1' }] });
      const { reservationId } = await engine.authorize(context('1'));
      await engine.release(reservationId as string);
      expect((await engine.evaluate(context('1'))).decision).toBe('allow');
    });

    it('does not reserve anything on a dry run', async () => {
      const engine = await engineWith({ periodLimits: [{ period: 'day', maxUsdc: '1' }] });
      await engine.evaluate(context('1'));
      expect((await engine.evaluate(context('1'))).decision).toBe('allow');
    });
  });

  describe('service lists', () => {
    const decide = async (url: string, lists: { allowlist?: string[]; blocklist?: string[] }) =>
      (await (await engineWith(lists)).evaluate(context('0.01', { url }))).decision;

    it.each([
      ['api.example.com', 'https://api.example.com/x', 'allow'],
      ['API.example.com', 'https://api.example.com/x', 'allow'],
      ['api.example.com', 'https://api.example.com./x', 'allow'],
      ['api.example.com', 'https://evil-api.example.com/x', 'deny'],
      ['api.example.com', 'https://api.example.com.evil.io/x', 'deny'],
      ['*.example.com', 'https://a.b.example.com/x', 'allow'],
      ['*.example.com', 'https://example.com/x', 'deny'],
      ['*.example.com', 'https://notexample.com/x', 'deny'],
      ['api.example.com/v1/*', 'https://api.example.com/v1/data', 'allow'],
      ['api.example.com/v1/*', 'https://api.example.com/v2/data', 'deny'],
      ['api.example.com/v1/*', 'https://api.example.com/v1/../v2/data', 'deny'],
      ['api.example.com/v1', 'https://api.example.com/v1/data', 'deny'],
    ])('allowlist %s against %s is %s', async (pattern, url, expected) => {
      expect(await decide(url, { allowlist: [pattern] })).toBe(expected);
    });

    it('permits nothing with an empty allowlist', async () => {
      expect(await decide(RESOURCE_URL, { allowlist: [] })).toBe('deny');
    });

    it('lets the blocklist win over the allowlist', async () => {
      const evaluation = await (
        await engineWith({ allowlist: ['*.example.com'], blocklist: ['api.example.com'] })
      ).evaluate(context('0.01'));
      expect(evaluation.decision).toBe('deny');
      expect(codes(evaluation)).toEqual(['SERVICE_BLOCKED']);
    });

    it('denies a URL that cannot be parsed', async () => {
      const evaluation = await (await engineWith({})).evaluate(context('0.01', { url: 'nope' }));
      expect(codes(evaluation)).toEqual(['INVALID_URL']);
    });

    it.each(['https://example.com', '', 'exa mple.com', 'example.com:8080'])(
      'rejects the invalid pattern %j',
      (pattern) => {
        expect(() => new SpendingPolicy({ allowlist: [pattern] })).toThrow(DevicePayError);
      },
    );
  });

  describe('approval threshold', () => {
    it('does not ask at exactly the threshold', async () => {
      const engine = await engineWith({ approvalThresholdUsdc: '0.50' });
      expect((await engine.evaluate(context('0.50'))).decision).toBe('allow');
    });

    it('asks above the threshold', async () => {
      const engine = await engineWith({ approvalThresholdUsdc: '0.50' });
      const evaluation = await engine.evaluate(context('0.500001'));
      expect(evaluation.decision).toBe('require_approval');
      expect(codes(evaluation)).toEqual(['APPROVAL_THRESHOLD']);
    });

    it('reserves budget while waiting for approval', async () => {
      const engine = await engineWith({
        approvalThresholdUsdc: '0.10',
        periodLimits: [{ period: 'day', maxUsdc: '1' }],
      });
      expect((await engine.authorize(context('1'))).reservationId).toBeDefined();
      expect((await engine.evaluate(context('0.01'))).decision).toBe('deny');
    });
  });

  describe('multiple policies', () => {
    it('denies when any policy denies, even if another requires approval', async () => {
      const engine = await engineWith(
        { approvalThresholdUsdc: '0.01' },
        { maxPerTransactionUsdc: '0.50' },
      );
      const evaluation = await engine.evaluate(context('1'));
      expect(evaluation.decision).toBe('deny');
      expect(codes(evaluation)).toEqual(['PER_TRANSACTION_LIMIT']);
    });

    it('requires approval when any policy does', async () => {
      const engine = await engineWith(
        { maxPerTransactionUsdc: '10' },
        { approvalThresholdUsdc: '0.50' },
      );
      expect((await engine.evaluate(context('1'))).decision).toBe('require_approval');
    });
  });

  it('keeps working after a store failure', async () => {
    class FlakyStore extends InMemoryPolicyStore {
      failNext = false;
      override async addSpend(...args: Parameters<InMemoryPolicyStore['addSpend']>) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('disk full');
        }
        return super.addSpend(...args);
      }
    }
    const store = new FlakyStore();
    const engine = new PolicyEngine({ store });
    await engine.addPolicy({ maxPerTransactionUsdc: '1' });

    store.failNext = true;
    await expect(engine.authorize(context('0.1'))).rejects.toThrow('disk full');
    expect((await engine.authorize(context('0.1'))).reservationId).toBeDefined();
  });

  it('restores policies through the store', async () => {
    const store = new InMemoryPolicyStore();
    const saved = await new PolicyEngine({ store }).addPolicy({ maxPerTransactionUsdc: '1' });
    const restored = await new PolicyEngine({ store }).listPolicies();
    expect(restored.map((policy) => policy.id)).toEqual([saved.id]);
  });

  it.each(['-1', '1.0000001', 'abc', '', '1e3', '.5'])('rejects the amount %j', (maxUsdc) => {
    expect(() => new SpendingPolicy({ maxPerTransactionUsdc: maxUsdc })).toThrow(DevicePayError);
  });
});
