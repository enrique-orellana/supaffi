import type { ProductChecks } from "@/lib/checks/product";

export const PaymentProvider = {
  STRIPE: {
    id: "stripe",
    database: "STRIPE",
    label: "Stripe",
    isReady: (connected: boolean, checks: ProductChecks) =>
      connected && checks.stripe.key.ok,
  },
  NOWPAYMENTS: {
    id: "nowpayments",
    database: "NOWPAYMENTS",
    label: "NOWPayments",
    isReady: (connected: boolean, _checks: ProductChecks) => connected,
  },
} as const;

export type PaymentProviderId =
  (typeof PaymentProvider)[keyof typeof PaymentProvider]["id"];
export type PaymentProviderDatabaseValue =
  (typeof PaymentProvider)[keyof typeof PaymentProvider]["database"];

export function isPaymentProviderReady(
  providerId: PaymentProviderId,
  connected: boolean,
  checks: ProductChecks,
): boolean {
  const provider = Object.values(PaymentProvider).find(
    ({ id }) => id === providerId,
  );
  return provider?.isReady(connected, checks) ?? false;
}

export type PaymentProviderCapabilities = {
  webhooks: boolean;
  hostedCheckout: boolean;
  recurringBilling: boolean;
  refunds: boolean;
  disputes: boolean;
};

/** Browser-safe checkout URL details used only to record referral attribution. */
export type ClientCheckoutTrackingAdapter = {
  responseUrlFields: readonly string[];
  allowedHosts: readonly string[];
  path: string;
  referenceQueryParameter: string;
};

export type PaymentConnectionSecrets = {
  webhookSecret: string;
};

export type VerifiedProviderEvent = {
  provider: PaymentProviderId;
  eventId: string;
  kind:
    | "payment_succeeded"
    | "payment_failed"
    | "payment_refunded"
    | "payment_pending"
    | "provider_specific";
  paymentRef: string | null;
  checkoutRef: string | null;
  saleAmount: string | null;
  saleCurrency: string | null;
  cryptoAmount: string | null;
  cryptoCurrency: string | null;
  occurredAt: Date;
  rawPayload: unknown;
};

export interface PaymentProviderAdapter {
  readonly provider: PaymentProviderId;
  readonly capabilities: Readonly<PaymentProviderCapabilities>;
  readonly clientTracking?: Readonly<ClientCheckoutTrackingAdapter>;
  verifyAndParseWebhook(input: {
    rawBody: string;
    headers: Headers;
    connection: PaymentConnectionSecrets;
  }): VerifiedProviderEvent | null;
}
