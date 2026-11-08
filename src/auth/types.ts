export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export type PolicyReasonCode =
  | 'NO_ACTIVE_POLICY'
  | 'INVALID_URL'
  | 'SERVICE_BLOCKED'
  | 'SERVICE_NOT_ALLOWED'
  | 'PER_TRANSACTION_LIMIT'
  | 'PERIOD_LIMIT'
  | 'APPROVAL_THRESHOLD'
  | 'NO_SUPPORTED_REQUIREMENT'
  | 'USER_DENIED';

export interface PolicyReason {
  code: PolicyReasonCode;
  message: string;
  policyId?: string;
}

/** The payment being evaluated. `url` must be the URL actually requested, not a server claim. */
export interface PaymentContext {
  url: string;
  /** Atomic USDC units. */
  amount: bigint;
  /** CAIP-2 network, e.g. `eip155:8453`. Spend is tracked separately per network. */
  network: string;
  payTo: string;
}

/** JSON-safe outcome of a policy evaluation. */
export interface PolicyEvaluation {
  decision: PolicyDecision;
  reasons: PolicyReason[];
  policyIds: string[];
  evaluatedAt: string;
  /** Set when the decision was `require_approval` and the user has answered. */
  userApproval?: 'approved' | 'denied';
}
