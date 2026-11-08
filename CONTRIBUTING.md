# Contributing

Thanks for helping improve Spraay Device Pay.

## Setup

You need Node 22 or later and pnpm 11 to develop. The published package supports Node 18 and later.

```sh
pnpm install
```

## Checks

Run these before opening a pull request. CI runs the same checks, and also runs the tests on Node 18.

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

## Integration test

The Base Sepolia test settles a real testnet payment, so it is skipped unless both variables are set:

```sh
DEVICE_PAY_TESTNET_PRIVATE_KEY=0x... DEVICE_PAY_TESTNET_URL=https://... pnpm test:integration
```

Use a throwaway wallet holding only Base Sepolia USDC, and an x402 endpoint that accepts payment on Base Sepolia. The test spends at most 0.10 USDC.

## Guidelines

- Never commit private keys. Read them from environment variables.
- Do not add a dependency on any hosted payment gateway or production contract. This SDK is standalone.
- Payment paths must fail closed. A missing policy, adapter, or audit log means the payment does not happen.
- Check `@x402/core` and `@x402/evm` exports against the published package rather than assuming them.
- Add tests with any change in behavior, particularly limits and denial paths.

## Security

Please report vulnerabilities privately through GitHub security advisories on `plagtech/spraay-device-pay`, not in a public issue.
