# Spraay Device Pay

`@plagtech/spraay-device-pay` is a standalone, open-source [x402](https://www.x402.org/) payment SDK for personal AI devices, wearables, and handheld assistants. AI agents can pay for resources in USDC on Base while the user stays in control through spending limits, authorization policies, and secure wallet signing.

The SDK is built on the official `@x402/core` and `@x402/evm` packages and does not depend on any hosted gateway. Phase 1 supports the `exact` payment scheme with x402 v2, on Base (chain ID 8453) and Base Sepolia (84532).

## Architecture

```text
 AI agent
    │  requestAccess(url)
    ▼
┌──────────────────────── DevicePayClient ────────────────────────┐
│  402 challenge                                                  │
│    │                                                            │
│    ▼                                                            │
│  PolicyEngine ──── PolicyStore (limits and spend history)       │
│    │  allow / require_approval / deny                           │
│    ▼                                                            │
│  DeviceAdapter ─── asks the user when policy requires it        │
│    │                                                            │
│    ▼                                                            │
│  WalletSigner ──── LocalSigner, or DelegatedSigner to a phone   │
│    │                                                            │
│    ▼                                                            │
│  Retry with PAYMENT-SIGNATURE, read PAYMENT-RESPONSE            │
│                                                                 │
│  TransactionLogger records every attempt                        │
└─────────────────────────────────────────────────────────────────┘
```

| Module         | Exports                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `src/payer`    | `DevicePayClient`, `selectRequirement`                                    |
| `src/auth`     | `SpendingPolicy`, `PolicyEngine`, `PolicyStore`, `InMemoryPolicyStore`    |
| `src/wallet`   | `WalletSigner`, `LocalSigner`, `DelegatedSigner`, `HttpSigningTransport`  |
| `src/log`      | `TransactionLogger`, `TransactionLogStore`, `InMemoryTransactionLogStore` |
| `src/adapters` | `DeviceAdapter`, `MockDeviceAdapter`, `CLIDeviceAdapter`                  |

## Quick start

Requires Node 18 or later.

```sh
pnpm add @plagtech/spraay-device-pay
```

```ts
import {
  BASE_SEPOLIA_CHAIN_ID,
  DevicePayClient,
  LocalSigner,
  PolicyEngine,
} from '@plagtech/spraay-device-pay';

const policyEngine = new PolicyEngine();
await policyEngine.addPolicy({ maxPerTransactionUsdc: '0.10' });

const client = new DevicePayClient({
  signer: LocalSigner.fromEnv(), // reads DEVICE_PAY_PRIVATE_KEY
  policyEngine,
  chainIds: [BASE_SEPOLIA_CHAIN_ID],
});

const url = 'https://your-x402-service.example/resource';
const access = await client.requestAccess(url);

if (access.paymentRequired) {
  const payment = await client.constructPayment(access.paymentRequired);
  const result = await client.executePayment(access.paymentRequired.url, payment);
  console.log(result.status, result.txHash);
}
```

Runnable versions are in [`examples/`](./examples). Copy `.env.example` for the variables they use.

```sh
pnpm exec tsx examples/basic-payment.ts
pnpm exec tsx examples/with-spending-limits.ts
```

## Spending policies

```ts
await policyEngine.addPolicy({
  name: 'Everyday budget',
  maxPerTransactionUsdc: '1.00',
  periodLimits: [
    { period: 'hour', maxUsdc: '2.00' },
    { period: 'day', maxUsdc: '5.00' },
    { period: 'month', maxUsdc: '25.00' },
  ],
  allowlist: ['api.example.com', '*.example.org', 'data.example.net/v1/*'],
  blocklist: ['*.untrusted.example'],
  approvalThresholdUsdc: '0.25',
});
```

- A payment must satisfy every enabled policy, and with no enabled policy it is denied.
- Periods are rolling windows. A month is 30 days. Spend is tracked per network.
- A limit may be spent exactly. Approval is needed only strictly above the threshold.
- Service patterns are `host`, `*.host` (subdomains only), `host/exact-path`, or `host/prefix/*`. They ignore the port.
- The blocklist beats the allowlist. An empty allowlist permits nothing.

## Signing

`LocalSigner` holds a key in process, and is meant for development and testing.

`DelegatedSigner` keeps the key on a paired phone or companion app. It sends each EIP-712 request through a `SigningTransport` and verifies the returned signature against the wallet address.

```ts
const signer = new DelegatedSigner({
  address: '0xYourWalletAddress',
  transport: new HttpSigningTransport({ url: 'https://companion.example/sign' }),
});
```

`HttpSigningTransport` POSTs a `SigningRequest` as JSON and expects `{ "signature": "0x..." }` or `{ "rejected": true }`. Your companion app should authenticate the device and show the decoded recipient, amount, and token before signing, because the device itself may be the compromised party. Set `verifySignatures: false` for smart contract wallets, whose signatures cannot be recovered locally.

## Device integrations

Extend `DeviceAdapter` to connect a device:

```ts
class MyWearableAdapter extends DeviceAdapter {
  async requestUserApproval(request: ApprovalRequest) {
    return showConfirmation(`Pay ${request.amount} USDC?`, request.signal);
  }
  async displayPaymentStatus(update: PaymentStatusUpdate) {
    showToast(`${update.status}: ${update.url}`);
  }
  async getVoiceCommand() {
    return nextVoiceCommand();
  }
}
```

An unanswered approval is denied after `approvalTimeoutMs` (60 seconds by default). Only an explicit `true` counts as approval.

## Safety behavior

- **Nothing is signed before authorization.** Policy and any required approval come first, and the attempt is logged before signing. If the audit log is unavailable, the payment does not proceed.
- **Limits apply to the real URL.** Policies judge the URL that issued the 402, never the `resource` the server claims.
- **The server can't choose the token or chain.** Only `exact` USDC at the pinned contract address on chains you enabled is accepted.
- **Payments are single-use and bound to one URL.** Paid requests don't follow redirects, so a signature is never forwarded to another host.
- **Concurrent payments can't overspend.** Evaluation and budget reservation are one atomic step per `PolicyEngine`.
- **A sent signature stays counted, even if the request fails.** A server can claim failure and still settle the signed authorization, so its word can't refund your budget. Only payments that never left the device are released. If you confirm on-chain that one did not settle, call `policyEngine.release(payment.reservationId)`.

## Persistence

The in-memory stores lose all policies and spend history on restart. For production, implement `PolicyStore` and `TransactionLogStore` on durable storage, so that limits survive a reboot. Reservations are serialized per `PolicyEngine` instance, so a store shared between processes also needs its own atomic check-and-reserve.

## Testing

```sh
pnpm test              # unit tests, no network or funds needed
pnpm test:integration  # settles on Base Sepolia, see CONTRIBUTING.md
```

## License

[MIT](./LICENSE) © Plagtech
