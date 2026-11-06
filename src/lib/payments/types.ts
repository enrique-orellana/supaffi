export type PaymentProviderId = "stripe" | "nowpayments";

export type PaymentProviderCapabilities = {
  webhooks: boolean;
  hostedCheckout: boolean;
  recurringBilling: boolean;
  refunds: boolean;
  disputes: boolean;
};

export type PaymentConnectionSecrets = {
  apiKey: string | null;
  webhookSecret: string;
};

export type CheckoutRequest = {
  amount: string;
  currency: string;
  sourceOrderId: string;
  successUrl: string;
  cancelUrl: string;
  /** Provider callback destination, when the adapter requires one. */
  callbackUrl?: string;
};

export type CheckoutResponse = {
  checkoutRef: string;
  checkoutUrl: string;
};

export class CheckoutProviderError extends Error {
  constructor(
    readonly outcome: "rejected" | "uncertain",
    message = "Hosted checkout creation failed",
    readonly providerRef?: string
  ) {
    super(message);
    this.name = "CheckoutProviderError";
  }
}

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
  verifyAndParseWebhook(input: {
    rawBody: string;
    headers: Headers;
    connection: PaymentConnectionSecrets;
  }): VerifiedProviderEvent | null;
  createCheckout?(
    input: CheckoutRequest,
    connection: PaymentConnectionSecrets
  ): Promise<CheckoutResponse>;
}
