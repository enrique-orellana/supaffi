import type { ComponentType } from "react";
import type { CheckSection } from "@/lib/checks/product";
import type { ProductChecks } from "@/lib/checks/product";
import { getIntegrationStatus } from "@/lib/merchant";
import { getNowPaymentsConnectionStatus } from "@/lib/paymentConnections";
import { PaymentProvider, type PaymentProviderId } from "./types";
import { NowPaymentsConnectionPanel } from "@/components/payments/NowPaymentsConnectionPanel";
import { StripeConnectionPanel } from "@/components/payments/StripeConnectionPanel";

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
  readStatus(ownerId: string, merchantId: string): Promise<PaymentProviderSetupStatus>;
  checkSections: readonly CheckSection[];
  panel: ComponentType<PaymentProviderPanelProps>;
};

const paymentProviderSetups: readonly PaymentProviderSetup[] = [
  {
    provider: PaymentProvider.STRIPE.id,
    label: PaymentProvider.STRIPE.label,
    panel: StripeConnectionPanel,
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

export function getPaymentProviderSetup(
  providerId: PaymentProviderId
): PaymentProviderSetup | undefined {
  return paymentProviderSetups.find(({ provider }) => provider === providerId);
}
