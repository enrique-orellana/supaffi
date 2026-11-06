import { PaymentProvider } from "../types";
import Stripe from "stripe";
import { minorUnitsToMajor } from "@/lib/stripe";
import type {
  PaymentProviderAdapter,
  VerifiedProviderEvent,
} from "../types";

type StripeObject = Record<string, unknown>;

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return null;
}

function amountOf(value: unknown, currency: string | null): string | null {
  if (typeof value !== "number" || !currency) return null;
  return String(minorUnitsToMajor(value, currency));
}

function eventKind(event: Stripe.Event, object: StripeObject): VerifiedProviderEvent["kind"] {
  switch (event.type) {
    case "checkout.session.async_payment_succeeded":
    case "invoice.paid":
      return "payment_succeeded";
    case "checkout.session.completed":
      return object.payment_status === "paid" ? "payment_succeeded" : "payment_pending";
    case "checkout.session.async_payment_failed":
    case "invoice.payment_failed":
      return "payment_failed";
    case "charge.refunded":
      return "payment_refunded";
    default:
      return "provider_specific";
  }
}

export const stripeAdapter: PaymentProviderAdapter = {
  provider: PaymentProvider.STRIPE.id,
  capabilities: {
    webhooks: true,
    hostedCheckout: false,
    recurringBilling: true,
    refunds: true,
    disputes: true,
  },
  verifyAndParseWebhook({ rawBody, headers, connection }) {
    const signature = headers.get("stripe-signature");
    if (!signature) return null;

    const event = Stripe.webhooks.constructEvent(rawBody, signature, connection.webhookSecret);
    const object = event.data.object as unknown as StripeObject;
    const currency = typeof object.currency === "string" ? object.currency.toLowerCase() : null;
    const paymentRef =
      idOf(object.payment_intent) ??
      idOf(object.invoice) ??
      idOf(object.id);
    const checkoutRef = event.type.startsWith("checkout.session.") ? idOf(object.id) : null;

    let amount: unknown = null;
    if (event.type.startsWith("checkout.session.")) amount = object.amount_total;
    else if (event.type === "invoice.paid") amount = object.amount_paid;
    else if (event.type === "charge.refunded") amount = object.amount;

    return {
      provider: PaymentProvider.STRIPE.id,
      eventId: event.id,
      kind: eventKind(event, object),
      paymentRef,
      checkoutRef,
      saleAmount: amountOf(amount, currency),
      saleCurrency: currency,
      cryptoAmount: null,
      cryptoCurrency: null,
      occurredAt: new Date(event.created * 1000),
      rawPayload: event,
    };
  },
};
