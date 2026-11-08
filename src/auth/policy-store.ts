import type { SpendingPolicyConfig } from './spending-policy.js';

/** A payment amount counted against spending limits. */
export interface SpendEntry {
  id: string;
  network: string;
  /** Atomic USDC units. */
  amount: bigint;
  /** Epoch milliseconds. */
  timestamp: number;
}

/**
 * Storage for policies and spend history. Implement this to persist across restarts.
 *
 * Policies stay in force and spend keeps counting only if the backend is durable, so a device that
 * reboots should not use the in-memory store in production.
 */
export interface PolicyStore {
  listPolicies(): Promise<SpendingPolicyConfig[]>;
  savePolicy(policy: SpendingPolicyConfig & { id: string }): Promise<void>;
  deletePolicy(id: string): Promise<void>;
  addSpend(entry: SpendEntry): Promise<void>;
  removeSpend(id: string): Promise<void>;
  /** Total atomic USDC on `network` with `timestamp > sinceMs`. */
  getSpentSince(network: string, sinceMs: number): Promise<bigint>;
}

export class InMemoryPolicyStore implements PolicyStore {
  readonly #policies = new Map<string, SpendingPolicyConfig>();
  readonly #spend = new Map<string, SpendEntry>();

  async listPolicies(): Promise<SpendingPolicyConfig[]> {
    return [...this.#policies.values()].map((policy) => structuredClone(policy));
  }

  async savePolicy(policy: SpendingPolicyConfig & { id: string }): Promise<void> {
    this.#policies.set(policy.id, structuredClone(policy));
  }

  async deletePolicy(id: string): Promise<void> {
    this.#policies.delete(id);
  }

  async addSpend(entry: SpendEntry): Promise<void> {
    this.#spend.set(entry.id, { ...entry });
  }

  async removeSpend(id: string): Promise<void> {
    this.#spend.delete(id);
  }

  async getSpentSince(network: string, sinceMs: number): Promise<bigint> {
    let total = 0n;
    for (const entry of this.#spend.values()) {
      if (entry.network === network && entry.timestamp > sinceMs) {
        total += entry.amount;
      }
    }
    return total;
  }
}
