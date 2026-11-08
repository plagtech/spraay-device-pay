import { randomUUID } from 'node:crypto';
import type { PolicyEvaluation } from '../auth/types.js';

export type TransactionStatus = 'approved' | 'denied' | 'settled' | 'failed';

export interface TransactionRecord {
  id: string;
  /** ISO 8601 time the attempt was first recorded. */
  timestamp: string;
  url: string;
  /** Decimal USDC. */
  amount: string;
  status: TransactionStatus;
  policyEvaluation: PolicyEvaluation;
  network?: string;
  payTo?: string;
  txHash?: string;
  error?: string;
}

export type TransactionUpdate = Partial<
  Pick<TransactionRecord, 'status' | 'txHash' | 'error' | 'policyEvaluation'>
>;

/** Storage for transaction records. Implement this to persist the audit trail. */
export interface TransactionLogStore {
  append(record: TransactionRecord): Promise<void>;
  update(id: string, update: TransactionUpdate): Promise<void>;
  /** Returns records oldest first. */
  list(): Promise<TransactionRecord[]>;
}

export class InMemoryTransactionLogStore implements TransactionLogStore {
  readonly #records = new Map<string, TransactionRecord>();

  async append(record: TransactionRecord): Promise<void> {
    this.#records.set(record.id, structuredClone(record));
  }

  async update(id: string, update: TransactionUpdate): Promise<void> {
    const record = this.#records.get(id);
    if (record) {
      this.#records.set(id, { ...record, ...structuredClone(update) });
    }
  }

  async list(): Promise<TransactionRecord[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

export interface TransactionLoggerOptions {
  store?: TransactionLogStore;
  now?: () => number;
}

/** Records every payment attempt, including the ones that were denied. */
export class TransactionLogger {
  readonly #store: TransactionLogStore;
  readonly #now: () => number;

  constructor(options: TransactionLoggerOptions = {}) {
    this.#store = options.store ?? new InMemoryTransactionLogStore();
    this.#now = options.now ?? Date.now;
  }

  async record(entry: Omit<TransactionRecord, 'id' | 'timestamp'>): Promise<TransactionRecord> {
    const record: TransactionRecord = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date(this.#now()).toISOString(),
    };
    await this.#store.append(record);
    return record;
  }

  update(id: string, update: TransactionUpdate): Promise<void> {
    return this.#store.update(id, update);
  }

  list(): Promise<TransactionRecord[]> {
    return this.#store.list();
  }
}
