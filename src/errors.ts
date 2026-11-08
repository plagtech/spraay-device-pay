import type { PolicyEvaluation } from './auth/types.js';

/** Base class for every error thrown by this SDK. */
export class DevicePayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The server's 402 response could not be parsed or uses an unsupported protocol version. */
export class InvalidChallengeError extends DevicePayError {}

/** A policy or the user refused the payment. No signature was produced. */
export class PaymentDeniedError extends DevicePayError {
  constructor(
    message: string,
    readonly evaluation: PolicyEvaluation,
  ) {
    super(message);
  }
}

/** The paid request could not be sent, or the payment handle was unusable. */
export class PaymentExecutionError extends DevicePayError {}

/** The wallet owner rejected a delegated signing request. */
export class SigningRejectedError extends DevicePayError {}

/** A delegated signing request did not complete in time. */
export class SigningTimeoutError extends DevicePayError {}
