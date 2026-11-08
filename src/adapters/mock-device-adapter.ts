import {
  DeviceAdapter,
  type ApprovalRequest,
  type PaymentStatusUpdate,
  type VoiceCommand,
} from './device-adapter.js';

export interface MockDeviceAdapterOptions {
  /** Answer given to approval requests. Defaults to true. */
  approve?: boolean;
  /** Commands returned in order by `getVoiceCommand()`. */
  voiceCommands?: VoiceCommand[];
}

/** Test adapter that auto-approves by default and records what it was asked to do. */
export class MockDeviceAdapter extends DeviceAdapter {
  readonly approvalRequests: ApprovalRequest[] = [];
  readonly statusUpdates: PaymentStatusUpdate[] = [];
  readonly #approve: boolean;
  readonly #voiceCommands: VoiceCommand[];

  constructor(options: MockDeviceAdapterOptions = {}) {
    super();
    this.#approve = options.approve ?? true;
    this.#voiceCommands = [...(options.voiceCommands ?? [])];
  }

  override async requestUserApproval(request: ApprovalRequest): Promise<boolean> {
    this.approvalRequests.push(request);
    return this.#approve;
  }

  override async displayPaymentStatus(update: PaymentStatusUpdate): Promise<void> {
    this.statusUpdates.push(update);
  }

  override async getVoiceCommand(): Promise<VoiceCommand | null> {
    return this.#voiceCommands.shift() ?? null;
  }
}
