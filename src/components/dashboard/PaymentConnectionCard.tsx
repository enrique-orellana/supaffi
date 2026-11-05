"use client";

import { useActionState } from "react";
import { CopyValue } from "@/components/CopyValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProductRef } from "@/lib/merchant";
import {
  disconnectNowPaymentsConnectionAction,
  saveNowPaymentsConnectionAction,
} from "@/app/dashboard/products/[product]/settings/settingsActions";

export function PaymentConnectionCard({
  product,
  connected,
  hasCallbackId,
  callbackUrl,
}: {
  product: ProductRef;
  connected: boolean;
  hasCallbackId: boolean;
  callbackUrl: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    saveNowPaymentsConnectionAction.bind(null, product),
    { error: "" }
  );

  return (
    <div className="grid gap-4 rounded-(--radius) border border-neutral-200 bg-neutral-50 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">NOWPayments</span>
          <span className="text-xs text-muted-foreground">
            {connected ? "Connected" : "Not connected"}
          </span>
        </div>
        {connected && (
          <form action={disconnectNowPaymentsConnectionAction.bind(null, product)}>
            <Button type="submit" variant="secondary" size="sm" className="cursor-pointer">
              Disconnect
            </Button>
          </form>
        )}
      </div>

      <form action={formAction} className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="nowpayments-api-key">API key</Label>
          <Input
            id="nowpayments-api-key"
            name="apiKey"
            type="password"
            autoComplete="new-password"
            placeholder={connected ? "Enter a replacement key" : "Paste API key"}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="nowpayments-ipn-secret">IPN secret</Label>
          <Input
            id="nowpayments-ipn-secret"
            name="ipnSecret"
            type="password"
            autoComplete="new-password"
            placeholder={connected ? "Enter a replacement secret" : "Paste IPN secret"}
            required
          />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          {state.error && <p role="alert" className="text-sm text-status-danger">{state.error}</p>}
          <Button type="submit" size="sm" className="w-fit cursor-pointer" disabled={pending}>
            {pending ? "Saving" : connected ? "Rotate credentials" : "Save credentials"}
          </Button>
        </div>
      </form>

      <div className="grid gap-1.5 border-t border-neutral-200 pt-3">
        <span className="text-xs text-muted-foreground">Callback URL</span>
        {callbackUrl ? (
          <CopyValue value={callbackUrl} className="font-mono text-xs" />
        ) : hasCallbackId ? (
          <p className="text-xs text-muted-foreground">
            Set the instance’s public domain to generate this URL.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Save credentials to generate this URL.
          </p>
        )}
      </div>
    </div>
  );
}
