import type { ComponentType } from "react";
import type { CheckSection } from "@/lib/checks/product";
import type { ProductChecks } from "@/lib/checks/product";
import { getIntegrationStatus } from "@/lib/merchant";
import { getNowPaymentsConnectionStatus } from "@/lib/paymentConnections";
import { REFERRAL_COOKIE, REFERRAL_METADATA_KEY } from "@/lib/referral";
import { checkoutPrompt } from "@/lib/integrationPrompt";
import { PaymentProvider, type PaymentProviderId } from "./types";
import { NowPaymentsConnectionPanel } from "@/components/payments/NowPaymentsConnectionPanel";
import { StripeConnectionPanel } from "@/components/payments/StripeConnectionPanel";

const stripeCheckoutSnippet = `const referralToken = cookies.get("${REFERRAL_COOKIE}");

await stripe.checkout.sessions.create({
  // ...your existing options
  metadata: {
    // ...your existing metadata
    ...(referralToken && { ${REFERRAL_METADATA_KEY}: referralToken }),
  },
});`;

export type PaymentProviderTrackingGuide = {
  provider: PaymentProviderId;
  label: string;
  title: string;
  description: string;
  checkoutSnippet?: string;
  checkoutPrompt?: string;
};

export type PaymentProviderSetupStatus = {
  connected: boolean;
  details?: Readonly<
    | { keyStored: boolean; webhookStored: boolean }
    | { callbackUrl: string | null }
  >;
};

export type PaymentProviderPanelProps = {
  provider: PaymentProviderId;
  label: string;
  product: { id: string; slug: string; name: string; domain: string };
  status: PaymentProviderSetupStatus;
  surface: "onboarding" | "settings";
  local: boolean;
  checks: ProductChecks;
  stripeKeyKind?: "restricted" | "secret" | null;
};

export type PaymentProviderSetup = {
  provider: PaymentProviderId;
  label: string;
  trackingGuide: Omit<PaymentProviderTrackingGuide, "provider" | "label">;
  readStatus(ownerId: string, merchantId: string): Promise<PaymentProviderSetupStatus>;
  checkSections: readonly CheckSection[];
  panel: ComponentType<PaymentProviderPanelProps>;
};

const paymentProviderSetups: readonly PaymentProviderSetup[] = [
  {
    provider: PaymentProvider.STRIPE.id,
    label: PaymentProvider.STRIPE.label,
    panel: StripeConnectionPanel,
    trackingGuide: {
      title: "Stripe Checkout sessions",
      description: "If you create Stripe Checkout Sessions yourself, pass the referral cookie to the session metadata. Stripe Payment Links, buy buttons and pricing tables need no checkout code.",
      checkoutSnippet: stripeCheckoutSnippet,
      checkoutPrompt: checkoutPrompt({ checkoutSnippet: stripeCheckoutSnippet }),
    },
    async readStatus(ownerId, merchantId) {
      const status = await getIntegrationStatus(ownerId, merchantId);
      return {
        connected: status.stripe,
        details: {
          keyStored: status.stripeKey,
          webhookStored: status.stripeWebhook,
        },
      };
    },
    checkSections: [PaymentProvider.STRIPE.id],
  },
  {
    provider: PaymentProvider.NOWPAYMENTS.id,
    label: PaymentProvider.NOWPAYMENTS.label,
    panel: NowPaymentsConnectionPanel,
    trackingGuide: {
      title: "NOWPayments hosted invoices",
      description: "Automatic capture supports successful same-origin fetch POSTs and cross-origin fetch POSTs whose responses the browser can read through CORS, when they return a fresh NOWPayments hosted invoice URL in JSON. The tracking script registers that invoice before checkout opens; it does not report payment success. Only signed notifications with a matching invoice_id can earn a commission. Reusing an invoice or paying one order with multiple payment IDs is not supported. XHR and other response formats are not detected. Configure the merchant-owned IPN relay so your existing webhook and Supaffi both receive payment notifications.",
    },
    async readStatus(ownerId, merchantId) {
      const status = await getNowPaymentsConnectionStatus(ownerId, merchantId);
      return {
        connected: status.connected,
        details: { callbackUrl: status.callbackUrl },
      };
    },
    checkSections: [],
  },
];

export function listPaymentProviderSetups(): readonly PaymentProviderSetup[] {
  return paymentProviderSetups;
}

export function listPaymentTrackingGuides(
  connectedProviders: readonly PaymentProviderId[]
): readonly PaymentProviderTrackingGuide[] {
  const connected = new Set(connectedProviders);
  return paymentProviderSetups
    .filter(({ provider }) => connected.has(provider))
    .map(({ provider, label, trackingGuide }) => ({ provider, label, ...trackingGuide }));
}

export function getPaymentProviderSetup(
  providerId: PaymentProviderId
): PaymentProviderSetup | undefined {
  return paymentProviderSetups.find(({ provider }) => provider === providerId);
}
