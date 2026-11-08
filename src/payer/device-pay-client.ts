import { randomUUID, webcrypto } from 'node:crypto';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ApprovalRequest, DeviceAdapter, PaymentStatus } from '../adapters/device-adapter.js';
import { formatUsdc } from '../amount.js';
import type { PolicyEngine } from '../auth/policy-engine.js';
import type { PolicyEvaluation } from '../auth/types.js';
import {
  DevicePayError,
  InvalidChallengeError,
  PaymentDeniedError,
  PaymentExecutionError,
} from '../errors.js';
import { TransactionLogger, type TransactionUpdate } from '../log/transaction-logger.js';
import { toCaip2, type SupportedChainId } from '../networks.js';
import type { WalletSigner } from '../wallet/types.js';
import { selectRequirement } from './challenge.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

export interface DevicePayClientConfig {
  signer: WalletSigner;
  policyEngine: PolicyEngine;
  /** Chains this client may pay on, most preferred first. There is no default, so real funds are opt-in. */
  chainIds: readonly SupportedChainId[];
  /** Needed for payments that require approval. Without one they are denied. */
  adapter?: DeviceAdapter;
  logger?: TransactionLogger;
  fetch?: typeof globalThis.fetch;
  /** An unanswered approval request is denied after this long. Defaults to 60 seconds. */
  approvalTimeoutMs?: number;
  /** Called when the log cannot be updated after a payment has already been sent. */
  onLogError?: (error: unknown) => void;
  now?: () => number;
}

/** A 402 challenge bound to the URL that actually issued it. */
export interface PaymentChallenge {
  url: string;
  required: PaymentRequired;
  init?: RequestInit;
}

export interface AccessResult {
  response: Response;
  /** Null when the server did not ask for payment. */
  paymentRequired: PaymentChallenge | null;
}

/** A signed, single-use payment. Only the client that created it can execute it. */
export interface ConstructedPayment {
  readonly id: string;
  readonly url: string;
  /** Decimal USDC. */
  readonly amount: string;
  readonly requirement: PaymentRequirements;
  readonly payload: PaymentPayload;
  readonly evaluation: PolicyEvaluation;
  /** Budget reservation backing this payment. */
  readonly reservationId: string;
  /** Epoch milliseconds after which the payment can no longer be executed. */
  readonly expiresAt: number;
}

export interface PaymentResult {
  status: 'settled' | 'failed';
  response: Response;
  settlement?: SettleResponse;
  txHash?: string;
  error?: string;
}

interface PendingPayment {
  payment: ConstructedPayment;
  logId: string;
  init: RequestInit | undefined;
}

/** `@x402/evm` uses the global `crypto`, which Node 18 does not expose by default. */
function ensureWebCrypto(): void {
  (globalThis as { crypto?: unknown }).crypto ??= webcrypto;
}

function normalizeUrl(url: string): string {
  return new URL(url).href;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * x402 payer for personal devices. Every payment passes the policy engine, and user approval where
 * policy requires it, before anything is signed.
 */
export class DevicePayClient {
  readonly #signer: WalletSigner;
  readonly #engine: PolicyEngine;
  readonly #chainIds: readonly SupportedChainId[];
  readonly #adapter: DeviceAdapter | undefined;
  readonly #logger: TransactionLogger;
  readonly #fetch: typeof globalThis.fetch;
  readonly #approvalTimeoutMs: number;
  readonly #onLogError: (error: unknown) => void;
  readonly #now: () => number;
  readonly #http: x402HTTPClient;
  readonly #pending = new Map<string, PendingPayment>();

  constructor(config: DevicePayClientConfig) {
    if (config.chainIds.length === 0) {
      throw new DevicePayError('At least one chain ID is required');
    }
    ensureWebCrypto();
    this.#signer = config.signer;
    this.#engine = config.policyEngine;
    this.#chainIds = config.chainIds;
    this.#adapter = config.adapter;
    this.#logger = config.logger ?? new TransactionLogger();
    this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.#onLogError =
      config.onLogError ?? ((error) => console.error('Transaction log update failed', error));
    this.#now = config.now ?? Date.now;

    // The policy engine is the source of truth for limits, so the upstream $1 default cap is off.
    const core = new x402Client().setSpendControls({ maxAmountPerPayment: false });
    const scheme = new ExactEvmScheme(this.#signer);
    for (const chainId of this.#chainIds) {
      core.register(toCaip2(chainId), scheme);
    }
    this.#http = new x402HTTPClient(core);
  }

  get logger(): TransactionLogger {
    return this.#logger;
  }

  /** Makes the initial request and parses a 402 challenge if the server returns one. */
  async requestAccess(url: string, init?: RequestInit): Promise<AccessResult> {
    const response = await this.#fetch(url, init);
    if (response.status !== 402) {
      return { response, paymentRequired: null };
    }

    let required: PaymentRequired;
    try {
      required = this.#http.getPaymentRequiredResponse((name) => response.headers.get(name));
    } catch (error) {
      throw new InvalidChallengeError('Could not parse the 402 payment challenge', {
        cause: error,
      });
    }
    if (required.x402Version !== 2 || !Array.isArray(required.accepts)) {
      throw new InvalidChallengeError(
        `Unsupported x402 challenge (version ${String(required.x402Version)})`,
      );
    }

    // After a redirect, the policy has to judge the server that actually asked for money.
    const challenge: PaymentChallenge = { url: response.url || url, required };
    if (init) challenge.init = init;
    return { response, paymentRequired: challenge };
  }

  /** Checks policy, obtains approval if required, and signs. Throws if the payment is refused. */
  async constructPayment(paymentRequired: PaymentChallenge): Promise<ConstructedPayment> {
    await this.#expirePending();
    const { url, required, init } = paymentRequired;

    const requirement = selectRequirement(required, this.#chainIds);
    if (!requirement) {
      const evaluation: PolicyEvaluation = {
        decision: 'deny',
        reasons: [
          {
            code: 'NO_SUPPORTED_REQUIREMENT',
            message: 'The server offered no exact USDC payment on an enabled chain',
          },
        ],
        policyIds: [],
        evaluatedAt: new Date(this.#now()).toISOString(),
      };
      await this.#logger.record({
        url,
        amount: '0',
        status: 'denied',
        policyEvaluation: evaluation,
      });
      await this.#display({ status: 'denied', url, message: evaluation.reasons[0]?.message });
      throw new PaymentDeniedError('No supported payment option', evaluation);
    }

    const atomicAmount = BigInt(requirement.amount);
    const amount = formatUsdc(atomicAmount);
    const details = { url, amount, network: requirement.network, payTo: requirement.payTo };

    const authorization = await this.#engine.authorize({ ...details, amount: atomicAmount });
    let evaluation = authorization.evaluation;
    const { reservationId } = authorization;
    if (reservationId === undefined) {
      return this.#deny(details, evaluation);
    }

    let logId: string | undefined;
    try {
      if (evaluation.decision === 'require_approval') {
        await this.#display({ status: 'awaiting_approval', url, amount });
        const approved = await this.#requestApproval({ ...details, evaluation });
        evaluation = { ...evaluation, userApproval: approved ? 'approved' : 'denied' };
        if (!approved) {
          evaluation = {
            ...evaluation,
            decision: 'deny',
            reasons: [
              ...evaluation.reasons,
              { code: 'USER_DENIED', message: 'The user did not approve this payment' },
            ],
          };
          await this.#engine.release(reservationId);
          return await this.#deny(details, evaluation);
        }
      }

      // Recorded before signing: if the audit log is unavailable, nothing gets signed.
      logId = (
        await this.#logger.record({ ...details, status: 'approved', policyEvaluation: evaluation })
      ).id;

      const payload = await this.#http.createPaymentPayload({
        ...required,
        accepts: [requirement],
      });
      const payment: ConstructedPayment = {
        id: randomUUID(),
        url,
        amount,
        requirement,
        payload,
        evaluation,
        reservationId,
        expiresAt: this.#now() + requirement.maxTimeoutSeconds * 1000,
      };
      this.#pending.set(payment.id, { payment, logId, init });
      await this.#display({ status: 'approved', url, amount });
      return payment;
    } catch (error) {
      if (error instanceof PaymentDeniedError) throw error;
      // Nothing was sent to the server, so the budget can safely be returned.
      await this.#engine.release(reservationId);
      if (logId) await this.#updateLog(logId, { status: 'failed', error: errorMessage(error) });
      await this.#display({ status: 'failed', url, amount, message: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Sends the signed payment and returns the resource. Once the signature has left the device its
   * amount stays counted, even on failure, because the server could still settle it on-chain.
   */
  async executePayment(
    url: string,
    payment: ConstructedPayment,
    init?: RequestInit,
  ): Promise<PaymentResult> {
    const pending = this.#pending.get(payment.id);
    if (!pending) {
      throw new PaymentExecutionError('Unknown, cancelled, expired, or already used payment');
    }
    const { amount, id, expiresAt, payload } = pending.payment;
    if (normalizeUrl(url) !== normalizeUrl(pending.payment.url)) {
      throw new PaymentExecutionError(`This payment was authorized for ${pending.payment.url}`);
    }
    if (this.#now() >= expiresAt) {
      await this.#cancel(pending, 'Payment expired before it was sent');
      throw new PaymentExecutionError('Payment has expired');
    }
    this.#pending.delete(id);

    const requestInit = init ?? pending.init;
    const headers = new Headers(requestInit?.headers);
    for (const [name, value] of Object.entries(this.#http.encodePaymentSignatureHeader(payload))) {
      headers.set(name, value);
    }

    let response: Response;
    try {
      // Redirects are not followed, so the signature is only ever sent to the authorized URL.
      response = await this.#fetch(url, { ...requestInit, headers, redirect: 'manual' });
    } catch (error) {
      await this.#updateLog(pending.logId, { status: 'failed', error: errorMessage(error) });
      await this.#display({ status: 'failed', url, amount, message: errorMessage(error) });
      throw new PaymentExecutionError('The paid request could not be completed', { cause: error });
    }

    const settlement = this.#parseSettlement(response);
    if (settlement?.success) {
      await this.#updateLog(pending.logId, { status: 'settled', txHash: settlement.transaction });
      await this.#display({ status: 'settled', url, amount, txHash: settlement.transaction });
      return { status: 'settled', response, settlement, txHash: settlement.transaction };
    }

    const error =
      settlement?.errorMessage ??
      settlement?.errorReason ??
      `No settlement confirmation (HTTP ${response.status})`;
    await this.#updateLog(pending.logId, { status: 'failed', error });
    await this.#display({ status: 'failed', url, amount, message: error });
    return { status: 'failed', response, error, ...(settlement ? { settlement } : {}) };
  }

  /** Discards an unsent payment and returns its amount to the budget. */
  async cancelPayment(payment: ConstructedPayment): Promise<void> {
    const pending = this.#pending.get(payment.id);
    if (pending) {
      await this.#cancel(pending, 'Payment cancelled before it was sent');
    }
  }

  async #deny(
    details: { url: string; amount: string; network: string; payTo: string },
    evaluation: PolicyEvaluation,
  ): Promise<never> {
    const message = evaluation.reasons.map((reason) => reason.message).join('; ');
    await this.#logger.record({ ...details, status: 'denied', policyEvaluation: evaluation });
    await this.#display({ status: 'denied', url: details.url, amount: details.amount, message });
    throw new PaymentDeniedError(`Payment denied: ${message}`, evaluation);
  }

  async #requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (!this.#adapter) return false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, this.#approvalTimeoutMs);
    });
    try {
      const answer = await Promise.race([
        this.#adapter.requestUserApproval({ ...request, signal: controller.signal }),
        timeout,
      ]);
      return answer === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  #parseSettlement(response: Response): SettleResponse | undefined {
    try {
      return this.#http.getPaymentSettleResponse((name) => response.headers.get(name));
    } catch {
      return undefined;
    }
  }

  async #cancel(pending: PendingPayment, reason: string): Promise<void> {
    this.#pending.delete(pending.payment.id);
    await this.#engine.release(pending.payment.reservationId);
    await this.#updateLog(pending.logId, { status: 'failed', error: reason });
  }

  async #expirePending(): Promise<void> {
    const now = this.#now();
    for (const pending of [...this.#pending.values()]) {
      if (now >= pending.payment.expiresAt) {
        await this.#cancel(pending, 'Payment expired before it was sent');
      }
    }
  }

  async #updateLog(id: string, update: TransactionUpdate): Promise<void> {
    try {
      await this.#logger.update(id, update);
    } catch (error) {
      this.#onLogError(error);
    }
  }

  /** A broken display must never change the outcome of a payment. */
  async #display(update: {
    status: PaymentStatus;
    url: string;
    amount?: string;
    message?: string | undefined;
    txHash?: string;
  }): Promise<void> {
    try {
      const { message, ...rest } = update;
      await this.#adapter?.displayPaymentStatus(
        message === undefined ? rest : { ...rest, message },
      );
    } catch {
      // Status display is best effort.
    }
  }
}
