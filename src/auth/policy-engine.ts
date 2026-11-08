import { randomUUID } from 'node:crypto';
import { InMemoryPolicyStore, type PolicyStore } from './policy-store.js';
import {
  PERIOD_MS,
  SpendingPolicy,
  type SpendingPolicyConfig,
  type SpentByPeriod,
} from './spending-policy.js';
import type { PaymentContext, PolicyEvaluation, PolicyReason } from './types.js';

export interface PolicyEngineOptions {
  store?: PolicyStore;
  /** Clock override, mainly for tests. */
  now?: () => number;
}

export interface Authorization {
  evaluation: PolicyEvaluation;
  /** Present unless denied. The amount stays counted until released with `release()`. */
  reservationId?: string;
}

/**
 * Evaluates payments against every enabled policy. The strictest outcome wins, and with no enabled
 * policy the engine denies.
 */
export class PolicyEngine {
  readonly #store: PolicyStore;
  readonly #now: () => number;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: PolicyEngineOptions = {}) {
    this.#store = options.store ?? new InMemoryPolicyStore();
    this.#now = options.now ?? Date.now;
  }

  async addPolicy(policy: SpendingPolicy | SpendingPolicyConfig): Promise<SpendingPolicy> {
    const instance = policy instanceof SpendingPolicy ? policy : new SpendingPolicy(policy);
    await this.#store.savePolicy({ ...instance.toConfig(), id: instance.id });
    return instance;
  }

  removePolicy(id: string): Promise<void> {
    return this.#store.deletePolicy(id);
  }

  async listPolicies(): Promise<SpendingPolicy[]> {
    const configs = await this.#store.listPolicies();
    return configs.map((config) => new SpendingPolicy(config));
  }

  /** Dry run: evaluates without reserving any spend. */
  evaluate(context: PaymentContext): Promise<PolicyEvaluation> {
    return this.#exclusive(() => this.#evaluate(context));
  }

  /**
   * Evaluates and, unless denied, reserves the amount in one atomic step, so concurrent payments
   * cannot each pass against the same remaining budget.
   */
  authorize(context: PaymentContext): Promise<Authorization> {
    return this.#exclusive(async () => {
      const evaluation = await this.#evaluate(context);
      if (evaluation.decision === 'deny') {
        return { evaluation };
      }
      const reservationId = randomUUID();
      await this.#store.addSpend({
        id: reservationId,
        network: context.network,
        amount: context.amount,
        timestamp: this.#now(),
      });
      return { evaluation, reservationId };
    });
  }

  /** Stops counting a reservation. Only safe if the signature was never given to the server. */
  release(reservationId: string): Promise<void> {
    return this.#exclusive(() => this.#store.removeSpend(reservationId));
  }

  async #evaluate(context: PaymentContext): Promise<PolicyEvaluation> {
    const evaluatedAt = new Date(this.#now()).toISOString();
    const policies = (await this.listPolicies()).filter((policy) => policy.enabled);
    if (policies.length === 0) {
      return {
        decision: 'deny',
        reasons: [{ code: 'NO_ACTIVE_POLICY', message: 'No spending policy is active' }],
        policyIds: [],
        evaluatedAt,
      };
    }

    const spent = await this.#spentByPeriod(context.network);
    const results = policies.map((policy) => policy.evaluate(context, spent));
    const denied = results.some((result) => result.decision === 'deny');
    const decision = denied
      ? 'deny'
      : results.some((result) => result.decision === 'require_approval')
        ? 'require_approval'
        : 'allow';
    const reasons: PolicyReason[] = results
      .filter((result) => !denied || result.decision === 'deny')
      .flatMap((result) => result.reasons);

    return { decision, reasons, policyIds: policies.map((policy) => policy.id), evaluatedAt };
  }

  async #spentByPeriod(network: string): Promise<SpentByPeriod> {
    const now = this.#now();
    const [hour, day, month] = await Promise.all([
      this.#store.getSpentSince(network, now - PERIOD_MS.hour),
      this.#store.getSpentSince(network, now - PERIOD_MS.day),
      this.#store.getSpentSince(network, now - PERIOD_MS.month),
    ]);
    return { hour, day, month };
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => undefined);
    return run;
  }
}
