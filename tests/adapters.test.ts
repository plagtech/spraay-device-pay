import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CLIDeviceAdapter } from '../src/adapters/cli-device-adapter.js';
import type { ApprovalRequest } from '../src/adapters/device-adapter.js';
import { MockDeviceAdapter } from '../src/adapters/mock-device-adapter.js';
import { PAY_TO, RESOURCE_URL, SEPOLIA } from './helpers.js';

const approval: ApprovalRequest = {
  url: RESOURCE_URL,
  amount: '0.5',
  network: SEPOLIA,
  payTo: PAY_TO,
  evaluation: {
    decision: 'require_approval',
    reasons: [],
    policyIds: [],
    evaluatedAt: new Date(0).toISOString(),
  },
};

function cli() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => (written += String(chunk)));
  return { adapter: new CLIDeviceAdapter({ input, output }), input, written: () => written };
}

describe('MockDeviceAdapter', () => {
  it('approves by default', async () => {
    await expect(new MockDeviceAdapter().requestUserApproval(approval)).resolves.toBe(true);
  });

  it('returns queued voice commands, then null', async () => {
    const adapter = new MockDeviceAdapter({ voiceCommands: [{ transcript: 'pay it' }] });
    await expect(adapter.getVoiceCommand()).resolves.toEqual({ transcript: 'pay it' });
    await expect(adapter.getVoiceCommand()).resolves.toBeNull();
  });
});

describe('CLIDeviceAdapter', () => {
  it.each([
    ['y', true],
    ['YES', true],
    ['', false],
    ['n', false],
    ['yep', false],
  ])('treats the answer %j as %s', async (answer, expected) => {
    const { adapter, input, written } = cli();
    const result = adapter.requestUserApproval(approval);
    input.write(`${answer}\n`);
    await expect(result).resolves.toBe(expected);
    expect(written()).toContain('0.5 USDC');
    expect(written()).toContain(PAY_TO);
  });

  it('rejects the prompt when aborted', async () => {
    const { adapter } = cli();
    const controller = new AbortController();
    const result = adapter.requestUserApproval({ ...approval, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow();
  });

  it('prints status updates', async () => {
    const { adapter, written } = cli();
    await adapter.displayPaymentStatus({
      status: 'settled',
      url: RESOURCE_URL,
      amount: '0.5',
      txHash: '0xabc',
    });
    expect(written()).toContain('[payment settled]');
    expect(written()).toContain('tx 0xabc');
  });

  it('reads typed voice commands', async () => {
    const { adapter, input } = cli();
    const result = adapter.getVoiceCommand();
    input.write('buy coffee\n');
    await expect(result).resolves.toEqual({ transcript: 'buy coffee' });
  });
});
