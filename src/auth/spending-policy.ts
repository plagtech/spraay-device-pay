import { randomUUID } from 'node:crypto';
import { formatUsdc, parseUsdc } from '../amount.js';
import { DevicePayError } from '../errors.js';
import type { PaymentContext, PolicyDecision, PolicyReason } from './types.js';

const HOUR_MS = 3_600_000;

export type SpendingPeriod = 'hour' | 'day' | 'month';

/** Rolling window length per period. A month is a rolling 30 days. */
export const PERIOD_MS: Readonly<Record<SpendingPeriod, number>> = {
  hour: HOUR_MS,
  day: 24 * HOUR_MS,
  month: 30 * 24 * HOUR_MS,
};

export interface PeriodLimit {
  period: SpendingPeriod;
  /** Maximum decimal USDC within the rolling window. */
  maxUsdc: string;
}

/**
 * Plain, JSON-serializable policy definition.
 *
 * Service patterns are `host`, `*.host` (subdomains only), and optionally a path: `host/exact` or
 * `host/prefix/*`.
 */
export interface SpendingPolicyConfig {
  id?: string;
  name?: string;
  enabled?: boolean;
  /** Maximum decimal USDC for one payment. */
  maxPerTransactionUsdc?: string;
  periodLimits?: PeriodLimit[];
  /** When set, only matching services can be paid. An empty list permits nothing. */
  allowlist?: string[];
  /** Matching services are always refused, even if also allowlisted. */
  blocklist?: string[];
  /** Payments strictly above this decimal USDC amount need user approval. */
  approvalThresholdUsdc?: string;
}

export type SpentByPeriod = Readonly<Record<SpendingPeriod, bigint>>;

export interface PolicyResult {
  decision: PolicyDecision;
  reasons: PolicyReason[];
}

interface ServicePattern {
  raw: string;
  matches(url: URL): boolean;
}

function compilePattern(raw: string): ServicePattern {
  const slash = raw.indexOf('/');
  const host = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? undefined : raw.slice(slash);
  if (!/^(\*\.)?[a-z0-9.-]+$/.test(host)) {
    throw new DevicePayError(`Invalid service pattern: ${JSON.stringify(raw)}`);
  }

  const matchesHost = host.startsWith('*.')
    ? (hostname: string) => hostname.endsWith(host.slice(1))
    : (hostname: string) => hostname === host;
  const matchesPath =
    path === undefined
      ? () => true
      : path.endsWith('*')
        ? (pathname: string) => pathname.startsWith(path.slice(0, -1))
        : (pathname: string) => pathname === path;

  return {
    raw,
    matches: (url) => matchesHost(url.hostname.replace(/\.$/, '')) && matchesPath(url.pathname),
  };
}

/** One set of spending rules. A payment must satisfy every enabled policy. */
export class SpendingPolicy {
  readonly id: string;
  readonly name: string | undefined;
  readonly enabled: boolean;

  readonly #config: SpendingPolicyConfig;
  readonly #maxPerTransaction: bigint | undefined;
  readonly #approvalThreshold: bigint | undefined;
  readonly #periodLimits: ReadonlyArray<{ period: SpendingPeriod; max: bigint }>;
  readonly #allowlist: ServicePattern[] | undefined;
  readonly #blocklist: ServicePattern[];

  constructor(config: SpendingPolicyConfig) {
    this.id = config.id ?? randomUUID();
    this.name = config.name;
    this.enabled = config.enabled ?? true;
    this.#config = { ...config, id: this.id };
    this.#maxPerTransaction =
      config.maxPerTransactionUsdc === undefined
        ? undefined
        : parseUsdc(config.maxPerTransactionUsdc);
    this.#approvalThreshold =
      config.approvalThresholdUsdc === undefined
        ? undefined
        : parseUsdc(config.approvalThresholdUsdc);
    this.#periodLimits = (config.periodLimits ?? []).map(({ period, maxUsdc }) => {
      if (!Object.hasOwn(PERIOD_MS, period)) {
        throw new DevicePayError(`Invalid spending period: ${JSON.stringify(period)}`);
      }
      return { period, max: parseUsdc(maxUsdc) };
    });
    this.#allowlist = config.allowlist?.map(compilePattern);
    this.#blocklist = (config.blocklist ?? []).map(compilePattern);
  }

  toConfig(): SpendingPolicyConfig {
    return structuredClone(this.#config);
  }

  evaluate(context: PaymentContext, spent: SpentByPeriod): PolicyResult {
    const deny = (code: PolicyReason['code'], message: string): PolicyReason => ({
      code,
      message,
      policyId: this.id,
    });
    const denials: PolicyReason[] = [];

    let url: URL | undefined;
    try {
      url = new URL(context.url);
    } catch {
      denials.push(deny('INVALID_URL', `Cannot parse URL: ${context.url}`));
    }

    if (url) {
      const blockedBy = this.#blocklist.find((pattern) => pattern.matches(url));
      if (blockedBy) {
        denials.push(deny('SERVICE_BLOCKED', `Service is blocked by "${blockedBy.raw}"`));
      }
      if (this.#allowlist && !this.#allowlist.some((pattern) => pattern.matches(url))) {
        denials.push(deny('SERVICE_NOT_ALLOWED', `${url.hostname} is not on the allowlist`));
      }
    }

    if (this.#maxPerTransaction !== undefined && context.amount > this.#maxPerTransaction) {
      denials.push(
        deny(
          'PER_TRANSACTION_LIMIT',
          `${formatUsdc(context.amount)} USDC exceeds the per-transaction limit of ${formatUsdc(this.#maxPerTransaction)} USDC`,
        ),
      );
    }

    for (const { period, max } of this.#periodLimits) {
      if (spent[period] + context.amount > max) {
        denials.push(
          deny(
            'PERIOD_LIMIT',
            `${formatUsdc(context.amount)} USDC would exceed the ${period} limit of ${formatUsdc(max)} USDC (${formatUsdc(spent[period])} USDC already spent)`,
          ),
        );
      }
    }

    if (denials.length > 0) {
      return { decision: 'deny', reasons: denials };
    }

    if (this.#approvalThreshold !== undefined && context.amount > this.#approvalThreshold) {
      return {
        decision: 'require_approval',
        reasons: [
          {
            code: 'APPROVAL_THRESHOLD',
            message: `${formatUsdc(context.amount)} USDC is above the approval threshold of ${formatUsdc(this.#approvalThreshold)} USDC`,
            policyId: this.id,
          },
        ],
      };
    }

    return { decision: 'allow', reasons: [] };
  }
}
