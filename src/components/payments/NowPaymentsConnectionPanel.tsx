"use client";

import { useActionState } from "react";
import { CopyValue } from "@/components/CopyValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PaymentProviderPanelProps } from "@/lib/payments/setupRegistry";
import { ProviderFeeFallbackForm } from "@/components/payments/ProviderFeeFallbackForm";
import {
  disconnectNowPaymentsConnectionAction,
  saveProviderFeeFallbackAction,
  saveNowPaymentsConnectionAction,
} from "@/app/dashboard/products/[product]/settings/settingsActions";
import {
  disconnectNowPaymentsOnboardingAction,
  saveProviderFeeFallbackOnboardingAction,
  saveNowPaymentsOnboardingAction,
} from "@/app/onboarding/[product]/paymentActions";

export function NowPaymentsConnectionPanel({
  provider,
  label,
  product,
  status,
  surface,
}: PaymentProviderPanelProps) {
  const callbackUrl =
    status.details && "callbackUrl" in status.details
      ? status.details.callbackUrl
      : null;
  const feeFallbackPercent =
    status.details && "feeFallbackPercent" in status.details
      ? status.details.feeFallbackPercent
      : null;
  const hasIpnSecret =
    status.details && "hasIpnSecret" in status.details
      ? status.details.hasIpnSecret
      : false;
  const connectionStatus = status.connected
    ? "Connected"
    : hasIpnSecret
      ? "Setup incomplete"
      : "Not connected";
  const saveAction =
    surface === "onboarding"
      ? saveNowPaymentsOnboardingAction
      : saveNowPaymentsConnectionAction;
  const disconnectAction =
    surface === "onboarding"
      ? disconnectNowPaymentsOnboardingAction
      : disconnectNowPaymentsConnectionAction;
  const saveFallbackAction =
    surface === "onboarding"
      ? saveProviderFeeFallbackOnboardingAction.bind(null, product, provider)
      : saveProviderFeeFallbackAction.bind(null, product, provider);
  const [state, formAction, pending] = useActionState(
    saveAction.bind(null, product),
    { error: "" },
  );

  return (
    <div className="grid gap-4 rounded-(--radius) border border-neutral-200 bg-neutral-50 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">{label}</span>
          <span className="text-xs text-muted-foreground">
            {connectionStatus}
          </span>
        </div>
        {hasIpnSecret && (
          <form action={disconnectAction.bind(null, product)}>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className="cursor-pointer"
            >
              Disconnect
            </Button>
          </form>
        )}
      </div>

      <form action={formAction} autoComplete="off" className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="nowpayments-ipn-secret">IPN secret</Label>
          <Input
            id="nowpayments-ipn-secret"
            name="ipnSecret"
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={
              hasIpnSecret ? "Saved — blank keeps it" : "Paste IPN secret"
            }
            required={!hasIpnSecret}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Supaffi verifies each signed NOWPayments callback with this secret.
        </p>
        <div className="flex flex-col gap-2">
          {state.error && (
            <p role="alert" className="text-sm text-status-danger">
              {state.error}
            </p>
          )}
          <Button
            type="submit"
            size="sm"
            className="w-fit cursor-pointer"
            disabled={pending}
          >
            {pending ? "Saving" : status.connected ? "Save" : "Connect"}
          </Button>
        </div>
      </form>

      <div className="border-t border-neutral-200 pt-3">
        <ProviderFeeFallbackForm
          action={saveFallbackAction}
          id={`provider-fee-fallback-${provider}`}
          value={feeFallbackPercent}
        />
      </div>

      <div className="grid gap-1.5 border-t border-neutral-200 pt-3">
        <span className="text-sm">Callback URL</span>
        {callbackUrl && status.connected ? (
          <CopyValue value={callbackUrl} className="font-mono text-xs" />
        ) : callbackUrl ? (
          <p className="text-xs text-muted-foreground">
            Save the IPN secret to enable signed payment verification.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Connect NOWPayments and configure a public domain to generate the
            URL.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          NOWPayments sends callbacks to one URL. If your app already uses it,
          keep that callback and add a relay that forwards the unchanged POST
          body and <code className="mx-1">x-nowpayments-sig</code> header here.
          Otherwise, use this URL directly in NOWPayments.
        </p>
      </div>
    </div>
  );
}
