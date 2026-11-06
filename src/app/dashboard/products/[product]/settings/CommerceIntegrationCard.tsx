"use client";

import { useActionState } from "react";
import { CopyValue } from "@/components/CopyValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProductRef } from "@/lib/merchant";
import {
  rotateCommerceIntegrationSecretAction,
  saveCommerceEventDestinationAction,
} from "./commerceIntegrationActions";

export function CommerceIntegrationCard({
  product,
  integrationId,
  configured,
  eventDestination,
}: {
  product: ProductRef;
  integrationId: string | null;
  configured: boolean;
  eventDestination: string | null;
}) {
  const [secretState, rotateAction, rotating] = useActionState(
    rotateCommerceIntegrationSecretAction.bind(null, product),
    { error: "" }
  );
  const [destinationState, saveDestinationAction, savingDestination] = useActionState(
    saveCommerceEventDestinationAction.bind(null, product),
    { error: "" }
  );

  return (
    <div className="grid gap-5 rounded-(--radius) border border-neutral-200 bg-neutral-50 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <span className="text-sm">Commerce integration</span>
          <span className="text-xs text-muted-foreground">
            {configured ? "Configured" : "Not configured"}
          </span>
        </div>
        <form action={rotateAction}>
          <Button type="submit" size="sm" variant="secondary" disabled={rotating}>
            {rotating ? "Updating" : configured ? "Rotate secret" : "Create secret"}
          </Button>
        </form>
      </div>

      {integrationId && (
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Integration ID</span>
          <CopyValue value={integrationId} className="font-mono text-xs" />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Send server requests to <span className="font-mono">/api/commerce/checkouts</span>. Use the
        <span className="font-mono"> x-commerce-integration-id</span>, <span className="font-mono">x-commerce-timestamp</span>
        (Unix seconds), and <span className="font-mono">x-commerce-signature</span> headers. Sign the UTF-8 bytes of
        <span className="font-mono"> timestamp + "." + exact JSON body</span> with HMAC-SHA256 and this secret, then send
        the lowercase hex digest. Timestamps are accepted for five minutes.
      </p>

      {secretState.secret && (
        <div className="grid gap-2 rounded-(--radius) border border-status-success/30 bg-white p-3">
          <p className="text-sm">Copy this secret now. It will not be shown again.</p>
          <CopyValue value={secretState.secret} className="font-mono text-xs" />
        </div>
      )}
      {secretState.error && <p role="alert" className="text-sm text-status-danger">{secretState.error}</p>}

      {integrationId && (
        <form action={saveDestinationAction} className="grid gap-3 border-t border-neutral-200 pt-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`commerce-destination-${product.id}`}>Event destination</Label>
            <Input
              id={`commerce-destination-${product.id}`}
              name="eventDestination"
              type="url"
              defaultValue={eventDestination ?? ""}
              placeholder="https://store.example/events"
              autoComplete="url"
            />
            <p className="text-xs text-muted-foreground">
              Use a public HTTPS endpoint. Leave blank to clear it.
            </p>
          </div>
          {destinationState.error && <p role="alert" className="text-sm text-status-danger">{destinationState.error}</p>}
          {destinationState.saved && <p role="status" className="text-sm text-status-success">Destination saved.</p>}
          <Button type="submit" size="sm" variant="secondary" className="w-fit" disabled={savingDestination}>
            {savingDestination ? "Saving" : "Save destination"}
          </Button>
        </form>
      )}
    </div>
  );
}
