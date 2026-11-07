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

export function NowPaymentsConnectionPanel({ label, product, status, surface }: PaymentProviderPanelProps) {
  const callbackUrl = status.details && "callbackUrl" in status.details ? status.details.callbackUrl : null;
  const saveAction =
    surface === "onboarding" ? saveNowPaymentsOnboardingAction : saveNowPaymentsConnectionAction;
  const disconnectAction =
    surface === "onboarding"
      ? disconnectNowPaymentsOnboardingAction
      : disconnectNowPaymentsConnectionAction;
  const [state, formAction, pending] = useActionState(
    saveAction.bind(null, product),
    { error: "" }
  );

  return (
    <div className="grid gap-4 rounded-(--radius) border border-neutral-200 bg-neutral-50 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">{label}</span>
          <span className="text-xs text-muted-foreground">
            {status.connected ? "Connected" : "Not connected"}
          </span>
        </div>
        {status.connected && (
          <form action={disconnectAction.bind(null, product)}>
            <Button type="submit" variant="secondary" size="sm" className="cursor-pointer">
              Disconnect
            </Button>
          </form>
        )}
      </div>

      <form action={formAction} className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="nowpayments-ipn-secret">IPN secret</Label>
          <Input
            id="nowpayments-ipn-secret"
            name="ipnSecret"
            type="password"
            autoComplete="new-password"
            placeholder={status.connected ? "Enter a replacement secret" : "Paste IPN secret"}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          {state.error && <p role="alert" className="text-sm text-status-danger">{state.error}</p>}
          <Button type="submit" size="sm" className="w-fit cursor-pointer" disabled={pending}>
            {pending ? "Saving" : status.connected ? "Rotate IPN secret" : "Save IPN secret"}
          </Button>
        </div>
      </form>

      <div className="grid gap-1.5 border-t border-neutral-200 pt-3">
        <span className="text-xs text-muted-foreground">Supaffi receiver URL</span>
        {callbackUrl ? (
          <CopyValue value={callbackUrl} className="font-mono text-xs" />
        ) : (
          <p className="text-xs text-muted-foreground">
            A saved connection and a public instance domain are required to generate this URL.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Set <code>SUPAFFI_WEBHOOK_URL</code> in your merchant-owned relay and set <code>EXISTING_WEBHOOK_URL</code> to your current payment webhook. Point the NOWPayments callback at the relay. It forwards the original signed notification to both destinations; Supaffi never calls your app.
        </p>
      </div>
    </div>
  );
}
