import { NOWPAYMENTS_PAYMENT_STATUS } from "./nowpaymentsApi";

const NO_PAYMENT_DELAYS_MS = [
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

const API_ERROR_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

const ACTIVE_PAYMENT_DELAYS_MS: Readonly<Record<string, number>> = {
  [NOWPAYMENTS_PAYMENT_STATUS.WAITING]: 60 * 60_000,
  [NOWPAYMENTS_PAYMENT_STATUS.PARTIALLY_PAID]: 60 * 60_000,
  [NOWPAYMENTS_PAYMENT_STATUS.CONFIRMING]: 5 * 60_000,
  [NOWPAYMENTS_PAYMENT_STATUS.CONFIRMED]: 5 * 60_000,
  [NOWPAYMENTS_PAYMENT_STATUS.SENDING]: 5 * 60_000,
};

const TERMINAL_PAYMENT_STATUSES = new Set<string>([
  NOWPAYMENTS_PAYMENT_STATUS.FINISHED,
  NOWPAYMENTS_PAYMENT_STATUS.FAILED,
  NOWPAYMENTS_PAYMENT_STATUS.EXPIRED,
  NOWPAYMENTS_PAYMENT_STATUS.REFUNDED,
]);

function beforeDeadline(candidate: Date, deadline: Date): Date | null {
  return candidate.getTime() < deadline.getTime() ? candidate : null;
}

/** Delay discovery checks when NOWPayments has no payment for a hosted invoice. */
export function nextNowPaymentsPollAt(input: {
  noPaymentChecks: number;
  paymentStatus?: string | null;
  now: Date;
  deadline: Date;
}): Date | null {
  if (input.deadline.getTime() <= input.now.getTime()) return null;

  const status = input.paymentStatus?.toLowerCase();
  if (status && TERMINAL_PAYMENT_STATUSES.has(status)) return null;

  const delay = status
    ? ACTIVE_PAYMENT_DELAYS_MS[status]
    : NO_PAYMENT_DELAYS_MS[
        Math.min(
          Math.max(0, input.noPaymentChecks),
          NO_PAYMENT_DELAYS_MS.length - 1,
        )
      ];
  if (delay === undefined) return null;

  return beforeDeadline(new Date(input.now.getTime() + delay), input.deadline);
}

/** Retry transient API failures with bounded backoff, still inside the buy window. */
export function nextNowPaymentsPollErrorAt(input: {
  failures: number;
  now: Date;
  deadline: Date;
}): Date | null {
  if (input.deadline.getTime() <= input.now.getTime()) return null;
  const delay =
    API_ERROR_DELAYS_MS[
      Math.min(Math.max(0, input.failures), API_ERROR_DELAYS_MS.length - 1)
    ];
  return beforeDeadline(new Date(input.now.getTime() + delay), input.deadline);
}

export function shouldCloseNowPaymentsAttribution(status: string): boolean {
  return TERMINAL_PAYMENT_STATUSES.has(status.toLowerCase());
}
