"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CopyValue } from "@/components/CopyValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProductRef } from "@/lib/merchant";
import {
  confirmNoCommerceInvoiceAction,
  rotateCommerceIntegrationSecretAction,
  saveCommerceEventDestinationAction,
  saveFoundCommerceInvoiceAction,
} from "./commerceIntegrationActions";
import type { UncertainCommerceCheckout } from "@/lib/commerceCheckouts";

export function CommerceIntegrationCard({
  product,
  integrationId,
  configured,
  eventDestination,
  uncertainCheckouts,
  uncertainCheckoutPage,
  uncertainCheckoutPageCount,
  uncertainCheckoutTotal,
  previousUncertainCheckoutHref,
  nextUncertainCheckoutHref,
}: {
  product: ProductRef;
  integrationId: string | null;
  configured: boolean;
  eventDestination: string | null;
  uncertainCheckouts: UncertainCommerceCheckout[];
  uncertainCheckoutPage: number;
  uncertainCheckoutPageCount: number;
  uncertainCheckoutTotal: number;
  previousUncertainCheckoutHref: string | null;
  nextUncertainCheckoutHref: string | null;
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

      <p className="text-xs text-muted-foreground">
        If a response is <span className="font-mono">uncertain</span>, an invoice may already exist. Retrying the request returns the same
        <span className="font-mono"> uncertain</span> result and does not query NOWPayments. Open Settings, search the invoice list by
        <span className="font-mono"> sourceOrderId</span>, then link the invoice you found or confirm that no invoice exists before allowing a retry.
      </p>

      {uncertainCheckouts.length > 0 && (
        <div className="grid gap-3 border-t border-neutral-200 pt-4">
          <div className="grid gap-1">
            <span className="text-sm">Checkouts that need reconciliation</span>
            <span className="text-xs text-muted-foreground">
              Search each order ID in the NOWPayments invoice list before choosing an action.
            </span>
          </div>
          {uncertainCheckouts.map((checkout) => (
            <CheckoutReconciliationRow key={checkout.id} product={product} checkout={checkout} />
          ))}
          {uncertainCheckoutPageCount > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={!previousUncertainCheckoutHref}
                render={previousUncertainCheckoutHref ? <Link href={previousUncertainCheckoutHref} /> : undefined}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {uncertainCheckoutPage + 1} of {uncertainCheckoutPageCount} · {uncertainCheckoutTotal} orders
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={!nextUncertainCheckoutHref}
                render={nextUncertainCheckoutHref ? <Link href={nextUncertainCheckoutHref} /> : undefined}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}

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

function CheckoutReconciliationRow({
  product,
  checkout,
}: {
  product: ProductRef;
  checkout: UncertainCommerceCheckout;
}) {
  const [foundState, saveFoundAction, savingFound] = useActionState(
    saveFoundCommerceInvoiceAction.bind(null, product, checkout.id),
    { error: "" }
  );
  const [absentState, confirmAbsentAction, confirmingAbsent] = useActionState(
    confirmNoCommerceInvoiceAction.bind(null, product, checkout.id),
    { error: "" }
  );
  const retryEligibleAt = new Date(checkout.updatedAt.getTime() + 15 * 60 * 1000);

  return (
    <div className="grid gap-3 rounded-(--radius) border border-status-warning/30 bg-white p-3">
      <div className="grid gap-1 text-sm">
        <span className="font-medium">{checkout.sourceOrderId}</span>
        <span className="text-xs text-muted-foreground">
          {checkout.amount} {checkout.currency.toUpperCase()} · updated {checkout.updatedAt.toLocaleString()}
        </span>
        {checkout.primaryInvoiceRef && (
          <span className="text-xs text-muted-foreground">Recorded invoice ID: {checkout.primaryInvoiceRef}</span>
        )}
        {checkout.alternateInvoiceRef && (
          <span className="text-xs text-muted-foreground">Alternate invoice ID: {checkout.alternateInvoiceRef}</span>
        )}
      </div>

      <form action={saveFoundAction} className="grid gap-2">
        <Label htmlFor={`invoice-ref-${checkout.id}`}>Verified invoice ID and hosted URL</Label>
        <p className="text-xs text-muted-foreground">
          Enter the invoice you verified in the provider list. It may differ from either recorded reference.
        </p>
        <Input
          id={`invoice-ref-${checkout.id}`}
          name="invoiceRef"
          placeholder="Verified invoice ID"
          required
          autoComplete="off"
        />
        <Input
          name="invoiceUrl"
          type="url"
          placeholder="https://nowpayments.io/payment/?iid=…"
          required
          autoComplete="url"
        />
        {foundState.error && <p role="alert" className="text-xs text-status-danger">{foundState.error}</p>}
        <Button type="submit" size="sm" variant="secondary" className="w-fit" disabled={savingFound}>
          {savingFound ? "Saving" : "Link found invoice"}
        </Button>
      </form>

      {!checkout.primaryInvoiceRef && !checkout.alternateInvoiceRef && (
        <form action={confirmAbsentAction} className="grid gap-2 border-t border-neutral-200 pt-3">
          <p className="text-xs text-muted-foreground">
            If no invoice appears after searching by this order ID, an identical request can be retried after {retryEligibleAt.toLocaleString()}.
          </p>
          <label className="flex items-start gap-2 text-xs">
            <input className="mt-0.5" type="checkbox" name="confirmNoInvoice" value="yes" required />
            I searched the NOWPayments invoice list for this order ID and confirmed that no invoice exists.
          </label>
          {absentState.error && <p role="alert" className="text-xs text-status-danger">{absentState.error}</p>}
          <Button type="submit" size="sm" variant="secondary" className="w-fit" disabled={confirmingAbsent}>
            {confirmingAbsent ? "Confirming" : "Allow one retry"}
          </Button>
        </form>
      )}
    </div>
  );
}
