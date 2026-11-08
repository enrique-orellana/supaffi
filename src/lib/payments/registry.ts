import type { PaymentProviderAdapter, PaymentProviderId } from "./types";
import { stripeAdapter } from "./providers/stripe";
import { nowpaymentsAdapter } from "./providers/nowpayments";

const adapters: ReadonlyMap<PaymentProviderId, PaymentProviderAdapter> =
  new Map<PaymentProviderId, PaymentProviderAdapter>([
    [stripeAdapter.provider, stripeAdapter],
    [nowpaymentsAdapter.provider, nowpaymentsAdapter],
  ]);

export function getPaymentProviderAdapter(
  provider: PaymentProviderId,
): PaymentProviderAdapter | undefined {
  return adapters.get(provider);
}

export function listPaymentProviderAdapters(): readonly PaymentProviderAdapter[] {
  return [...adapters.values()];
}
