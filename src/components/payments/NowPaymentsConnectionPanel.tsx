"use client";

import { useActionState } from "react";
import { CopyValue } from "@/components/CopyValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PaymentProviderPanelProps } from "@/lib/payments/setupRegistry";
import {
  disconnectNowPaymentsConnectionAction,
  saveNowPaymentsConnectionAction,
} from "@/app/dashboard/products/[product]/settings/settingsActions";
import {
  disconnectNowPaymentsOnboardingAction,
  saveNowPaymentsOnboardingAction,
} from "@/app/onboarding/[product]/paymentActions";

export function NowPaymentsConnectionPanel({
  label,
  product,
  status,
  surface,
}: PaymentProviderPanelProps) {
  const callbackUrl =
    status.details && "callbackUrl" in status.details
      ? status.details.callbackUrl
      : null;
  const apiKeyStored =
    status.details && "hasApiKey" in status.details
      ? status.details.hasApiKey
      : false;
  const hasIpnSecret =
    status.details && "hasIpnSecret" in status.details
      ? status.details.hasIpnSecret
      : false;
  const hasCredentials = apiKeyStored || hasIpnSecret;
  const connectionStatus = status.connected
    ? "Connected"
    : hasCredentials
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
        {(apiKeyStored || hasIpnSecret) && (
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
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="nowpayments-api-key">API key</Label>
            <Input
              id="nowpayments-api-key"
              name="apiKey"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={
                apiKeyStored ? "Saved — blank keeps it" : "Paste API key"
              }
              required={!apiKeyStored}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nowpayments-ipn-secret">IPN secret</Label>
            <Input
              id="nowpayments-ipn-secret"
              name="ipnSecret"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={
                hasIpnSecret ? "Saved — blank keeps it" : "Paste IPN secret"
              }
              required={!hasIpnSecret}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The API key checks payment status; the IPN secret verifies signed
          callbacks.
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

      <div className="grid gap-1.5 border-t border-neutral-200 pt-3">
        <span className="text-sm">Callback URL</span>
        {callbackUrl && status.connected ? (
          <CopyValue value={callbackUrl} className="font-mono text-xs" />
        ) : callbackUrl ? (
          <p className="text-xs text-muted-foreground">
            Save both credentials to enable signed payment verification.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Connect NOWPayments and configure a public domain to generate the
            URL.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Add this URL in NOWPayments. To keep another webhook, route
          notifications through the relay.
        </p>
      </div>
    </div>
  );
}
