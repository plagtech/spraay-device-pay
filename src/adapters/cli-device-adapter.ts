import { createInterface } from 'node:readline/promises';
import {
  DeviceAdapter,
  type ApprovalRequest,
  type PaymentStatusUpdate,
  type VoiceCommand,
} from './device-adapter.js';

export interface CLIDeviceAdapterOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Prompts in the terminal. Typed text stands in for voice input. */
export class CLIDeviceAdapter extends DeviceAdapter {
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;

  constructor(options: CLIDeviceAdapterOptions = {}) {
    super();
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
  }

  override async requestUserApproval(request: ApprovalRequest): Promise<boolean> {
    const prompt = `Pay ${request.amount} USDC to ${request.payTo} on ${request.network}\nfor ${request.url}? [y/N] `;
    const answer = await this.#ask(prompt, request.signal);
    return /^y(es)?$/i.test(answer.trim());
  }

  override async displayPaymentStatus(update: PaymentStatusUpdate): Promise<void> {
    const parts = [`[payment ${update.status}]`, update.url];
    if (update.amount !== undefined) parts.push(`${update.amount} USDC`);
    if (update.txHash) parts.push(`tx ${update.txHash}`);
    if (update.message) parts.push(update.message);
    this.#output.write(`${parts.join(' ')}\n`);
  }

  override async getVoiceCommand(): Promise<VoiceCommand | null> {
    const transcript = (await this.#ask('voice> ')).trim();
    return transcript ? { transcript } : null;
  }

  async #ask(prompt: string, signal?: AbortSignal): Promise<string> {
    const readline = createInterface({ input: this.#input, output: this.#output });
    try {
      return await readline.question(prompt, signal ? { signal } : {});
    } finally {
      readline.close();
    }
  }
}
