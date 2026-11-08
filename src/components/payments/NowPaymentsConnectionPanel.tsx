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
  const invoiceLookupReady =
    status.details && "invoiceLookupReady" in status.details
      ? status.details.invoiceLookupReady
      : false;
  const hasIpnSecret =
    status.details && "hasIpnSecret" in status.details
      ? status.details.hasIpnSecret
      : false;
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
            {status.connected ? "Connected" : "Not connected"}
          </span>
        </div>
        {status.connected && (
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

      <form action={formAction} className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="nowpayments-api-key">API key</Label>
            <Input
              id="nowpayments-api-key"
              name="apiKey"
              type="password"
              autoComplete="new-password"
              placeholder={
                status.connected
                  ? "Enter a replacement API key"
                  : "Paste API key"
              }
              required={!status.connected}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nowpayments-ipn-secret">
              IPN secret{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="nowpayments-ipn-secret"
              name="ipnSecret"
              type="password"
              autoComplete="new-password"
              placeholder={
                status.connected
                  ? "Enter a replacement secret"
                  : "Paste IPN secret if using callbacks"
              }
            />
          </div>
        </div>
        <div className="grid gap-2 rounded-(--radius) border border-neutral-200 bg-background p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">Invoice status checks</span>
            <span className="text-xs text-muted-foreground">
              {invoiceLookupReady ? "Enabled" : "Needs setup"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Supaffi uses a NOWPayments account with payment viewing access to
            find payment IDs for tracked invoices. Use a separate team account
            with View permission. Supaffi verifies payment status with the API
            key before recording a sale; it does not use payout access. This
            works without an IPN callback.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="nowpayments-account-email">
                NOWPayments account email
              </Label>
              <Input
                id="nowpayments-account-email"
                name="apiAccountEmail"
                type="email"
                autoComplete="username"
                placeholder={
                  invoiceLookupReady
                    ? "Enter a replacement email"
                    : "Email for the view-only account"
                }
                required={!invoiceLookupReady}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nowpayments-account-password">
                NOWPayments account password
              </Label>
              <Input
                id="nowpayments-account-password"
                name="apiAccountPassword"
                type="password"
                autoComplete="new-password"
                placeholder={
                  invoiceLookupReady
                    ? "Enter a replacement password"
                    : "Password for the view-only account"
                }
                required={!invoiceLookupReady}
              />
            </div>
          </div>
          {invoiceLookupReady && (
            <p className="text-xs text-muted-foreground">
              Leave both account fields empty to keep the saved login. Supaffi
              encrypts it and caches NOWPayments’ short-lived token in memory.
            </p>
          )}
        </div>
        {status.connected && (
          <p className="text-xs text-muted-foreground">
            Leave a field empty to keep its saved value. Supaffi encrypts all
            saved credentials.
          </p>
        )}
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
            {pending
              ? "Saving"
              : status.connected
                ? "Update credentials"
                : "Connect NOWPayments"}
          </Button>
        </div>
      </form>

      <div className="grid gap-1.5 border-t border-neutral-200 pt-3">
        <span className="text-xs text-muted-foreground">
          Optional NOWPayments IPN callback URL
        </span>
        {callbackUrl && hasIpnSecret ? (
          <CopyValue value={callbackUrl} className="font-mono text-xs" />
        ) : callbackUrl ? (
          <p className="text-xs text-muted-foreground">
            Add an IPN secret above to enable callbacks. API invoice checks work
            without this URL.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            A saved connection and a public instance domain are required to
            generate this URL.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          The API checks run without changing your checkout or callback. If you
          enable IPN callbacks, NOWPayments can send faster updates here. If an
          invoice has its own callback URL, NOWPayments uses that URL for its
          notifications.
        </p>
      </div>
    </div>
  );
}
