import type { PolicyEvaluation } from '../auth/types.js';

export interface ApprovalRequest {
  url: string;
  /** Decimal USDC. */
  amount: string;
  network: string;
  payTo: string;
  evaluation: PolicyEvaluation;
  /** Aborted when the approval window closes, so a pending prompt can be dismissed. */
  signal?: AbortSignal;
}

export type PaymentStatus = 'awaiting_approval' | 'approved' | 'denied' | 'settled' | 'failed';

export interface PaymentStatusUpdate {
  status: PaymentStatus;
  url: string;
  /** Decimal USDC, absent if no amount had been selected. */
  amount?: string;
  message?: string;
  txHash?: string;
}

export interface VoiceCommand {
  transcript: string;
  confidence?: number;
}

/** Extend this to integrate a wearable, handheld, or other personal device. */
export abstract class DeviceAdapter {
  /** Resolves true only if the user explicitly approved. */
  abstract requestUserApproval(request: ApprovalRequest): Promise<boolean>;
  abstract displayPaymentStatus(update: PaymentStatusUpdate): Promise<void>;
  /** Resolves with the next voice command, or null if there is none. */
  abstract getVoiceCommand(): Promise<VoiceCommand | null>;
}
