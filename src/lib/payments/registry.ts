import type { PaymentProviderAdapter, PaymentProviderId } from "./types";
import { stripeAdapter } from "./providers/stripe";

const adapters: ReadonlyMap<PaymentProviderId, PaymentProviderAdapter> = new Map<
  PaymentProviderId,
  PaymentProviderAdapter
>([[stripeAdapter.provider, stripeAdapter]]);

export function getPaymentProviderAdapter(
  provider: PaymentProviderId
): PaymentProviderAdapter | undefined {
  return adapters.get(provider);
}

export function listPaymentProviderAdapters(): readonly PaymentProviderAdapter[] {
  return [...adapters.values()];
}
