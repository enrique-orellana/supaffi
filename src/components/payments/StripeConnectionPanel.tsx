import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CheckList } from "@/components/onboarding/CheckList";
import {
  checkState,
  stripeKeyPending,
} from "@/components/onboarding/checkRows";
import type { CheckRow } from "@/components/onboarding/checkRows";
import { CodeBlock } from "@/components/onboarding/CodeBlock";
import { PasteField } from "@/components/PasteField";
import { TaskCard, TaskCardSection } from "@/components/onboarding/TaskCard";
import { restrictedKeyUrl } from "@/lib/stripeRestrictedKey";
import type { PaymentProviderPanelProps } from "@/lib/payments/setupRegistry";
import { ProviderFeeFallbackForm } from "@/components/payments/ProviderFeeFallbackForm";
import {
  saveStripeKeyAction,
  saveWebhookSecretAction,
  saveProviderFeeFallbackOnboardingAction,
} from "@/app/onboarding/[product]/paymentActions";
import { saveProviderFeeFallbackAction } from "@/app/dashboard/products/[product]/settings/settingsActions";

type StripeStatusDetails = {
  keyStored: boolean;
  webhookStored: boolean;
  feeFallbackPercent: string | null;
};

function stripeDetails(
  status: PaymentProviderPanelProps["status"],
): StripeStatusDetails {
  return status.details && "keyStored" in status.details
    ? status.details
    : {
        keyStored: false,
        webhookStored: false,
        feeFallbackPercent: null,
      };
}

export function StripeConnectionPanel({
  provider,
  label,
  product,
  status,
  surface,
  local,
  checks,
  stripeKeyKind,
}: PaymentProviderPanelProps) {
  const details = stripeDetails(status);
  const productRef = { id: product.id, slug: product.slug };
  const saveFallbackAction =
    surface === "onboarding"
      ? saveProviderFeeFallbackOnboardingAction.bind(null, productRef, provider)
      : saveProviderFeeFallbackAction.bind(null, productRef, provider);
  const settingsHref = `/dashboard/products/${product.slug}/settings`;
  const replaceLink = (which: string) => (
    <Button
      variant="secondary"
      size="sm"
      render={<Link href={`${settingsHref}?replace=${which}`} />}
    >
      Replace
    </Button>
  );

  if (surface === "settings") {
    const rows: CheckRow[] = [
      {
        id: "stripe-key",
        state: !details.keyStored
          ? "pending"
          : checks.stripe.key.ok
            ? "ok"
            : "failed",
        pending: "No Stripe key yet",
        passed: "Connected to Stripe",
        failed: "Stripe rejected the key",
        hint: "Replace it with a new one.",
        action: replaceLink("stripe-key"),
      },
      {
        id: "stripe-webhook",
        state: !details.webhookStored
          ? "pending"
          : checks.stripe.webhook.ok
            ? "ok"
            : "pending",
        pending: details.webhookStored
          ? "Waiting for the first event from Stripe"
          : "No webhook yet",
        passed: "Receiving events from Stripe",
        action: replaceLink("stripe-webhook"),
      },
    ];

    return (
      <div className="grid gap-3 rounded-(--radius) border border-neutral-200 bg-neutral-50">
        <div className="flex flex-wrap items-start justify-between gap-2 px-5 pt-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">{label}</span>
            <span className="text-xs text-muted-foreground">
              {stripeKeyKind
                ? `${stripeKeyKind === "restricted" ? "Restricted key" : "Full account key"}`
                : "Not connected"}
            </span>
          </div>
        </div>
        <div className="rounded-(--radius) border border-neutral-200 bg-card">
          <CheckList rows={rows} />
        </div>
        {stripeKeyKind === "secret" && (
          <p className="px-5 pb-4 text-xs text-muted-foreground">
            This is a full account key. A restricted key is safer.{" "}
            <a
              className="cursor-pointer underline"
              href={restrictedKeyUrl(product.name)}
              target="_blank"
              rel="noreferrer"
            >
              Create one in Stripe
            </a>
          </p>
        )}
        <div className="border-t border-neutral-200 px-5 pb-4 pt-3">
          <ProviderFeeFallbackForm
            action={saveFallbackAction}
            id={`provider-fee-fallback-${provider}`}
            value={details.feeFallbackPercent}
          />
        </div>
      </div>
    );
  }

  return (
    <TaskCard>
      <div className="flex min-h-11 items-center justify-between gap-3 bg-neutral-100 px-4 py-1.5">
        <span className="text-[13px] font-medium text-neutral-700">
          {label}
        </span>
        <span className="text-xs text-muted-foreground">
          {status.connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <TaskCardSection className="p-4">
        <Button
          variant="secondary"
          size="lg"
          render={
            <a
              href={restrictedKeyUrl(product.name)}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          <Image
            src="/logos/stripe.svg"
            alt=""
            width={16}
            height={16}
            className="mr-1 size-4"
          />
          Create the key in Stripe
        </Button>
      </TaskCardSection>

      {details.keyStored && (
        <TaskCardSection sunken>
          <CheckList
            rows={[
              {
                id: "stripe-key",
                state: checkState(checks.stripe.key, stripeKeyPending),
                pending: "Checking the key",
                passed: "Supaffi can read your Stripe payments",
                failed: "Stripe rejected that key",
                hint:
                  checks.stripe.key.detail ||
                  "Create a new one and paste it again.",
              },
            ]}
          />
        </TaskCardSection>
      )}

      <TaskCardSection className="p-4">
        <PasteField
          label={details.keyStored ? "Replace the key" : "Paste the key here"}
          placeholder="rk_live_..."
          action={saveStripeKeyAction.bind(null, productRef)}
          submitLabel={details.keyStored ? "Replace" : "Continue"}
        />
      </TaskCardSection>

      {details.keyStored && local && (
        <>
          <TaskCardSection className="p-4">
            <CodeBlock
              title="Local instance: forward events with the Stripe CLI"
              code={`stripe listen --forward-to ${product.domain}/api/webhooks/stripe`}
            />
          </TaskCardSection>
          <TaskCardSection className="p-4">
            <PasteField
              label={
                details.webhookStored
                  ? "Replace the signing secret it prints"
                  : "Paste the signing secret it prints"
              }
              placeholder="whsec_..."
              action={saveWebhookSecretAction.bind(null, productRef)}
              submitLabel="Save"
            />
          </TaskCardSection>
        </>
      )}

      <TaskCardSection className="p-4">
        <ProviderFeeFallbackForm
          action={saveFallbackAction}
          id={`provider-fee-fallback-${provider}`}
          value={details.feeFallbackPercent}
        />
      </TaskCardSection>
    </TaskCard>
  );
}
