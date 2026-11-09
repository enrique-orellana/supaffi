"use client";

import { useRouter } from "next/navigation";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import type { CommissionStatus } from "@/lib/commissionStatus";
import { voidReasonText, flagReasonText } from "@/lib/commissionReason";
import {
  markPaidAction,
  confirmFraudAction,
  dismissFlagAction,
  voidAction,
} from "./commissionActions";

/**
 * One commission in detail, and the one action that fits the state it is in.
 *
 * The list selects with `?commission=<id>` and the panel is rendered on the
 * server from that row, so there is no client copy of a commission to keep in
 * step with a write. Closing is a navigation back to the list, which is why
 * the URL it returns to arrives as a prop: the filters and the page were
 * already in it.
 */

export type SheetCommission = {
  id: string;
  status: CommissionStatus;
  /** Held back from payment by an open dispute. Shown as the status. */
  disputed?: boolean;
  /** Already carries its currency, since amounts are never converted. */
  amount: string;
  /**
   * The same amount as a plain two-decimal figure, no currency. Bound into
   * Mark paid, which records the commission at exactly this figure.
   */
  payTotal: string;
  /** What this commission was before a partial refund reduced it. Null when unchanged. */
  grossAmount: string | null;
  /** Eligible sale before the processor fee was subtracted. */
  saleAmount?: string | null;
  providerFeeAmount?: string | null;
  providerFeeSource?: "ACTUAL" | "FALLBACK" | null;
  affiliate: string;
  affiliateEmail: string;
  createdLabel: string;
  payableLabel: string;
  /** When a voided commission was voided. */
  voidedLabel: string | null;
  /** Internal token from the worker or an owner's own note, rendered through voidReasonText. */
  voidReason: string | null;
  /** Internal token from fraud detection, rendered through flagReasonText. */
  flagReason: string | null;
  /** What it is waiting on, or what happened to it. */
  stateLabel: string;
  /** When the click this sale was attributed to happened. */
  clickLabel: string;
  /** The link that click came through, when it still has one. */
  linkLabel: string | null;
  reference: { text: string; href: string | null } | null;
  paymentProvider?: string | null;
  cryptoAmount?: string | null;
  cryptoCurrency?: string | null;
  cryptoNetwork?: string | null;
  /** A refund adjustment row an older version wrote. It has no referral to confirm. */
  isAdjustment?: boolean;
  /** The Owner already confirmed this commission's referral as a self referral. */
  selfReferralConfirmed?: boolean;
};

const STATUS_LABELS: Record<CommissionStatus, string> = {
  [COMMISSION_STATUS.PENDING]: "On hold",
  [COMMISSION_STATUS.PAYABLE]: "Payable",
  [COMMISSION_STATUS.FLAGGED]: "Flagged",
  [COMMISSION_STATUS.PAID]: "Paid",
  [COMMISSION_STATUS.VOIDED]: "Voided",
};

function Line({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-60 text-right break-words">{children}</span>
    </div>
  );
}

/**
 * Splits one `flagReasonText` evidence entry into its label and its value.
 *
 * The contract with `src/lib/commissionReason.ts`: every entry is
 * `"<one-word label> <value>"`, e.g. `"Buyer sarah@northwind.example"`, and
 * the value never contains a space, so the first space is the split. The copy
 * for a flag lives there and only there, which is why this reads the string
 * apart instead of writing its own words for the two halves.
 */
function splitEvidence(entry: string): { label: string; value: string } {
  const spaceAt = entry.indexOf(" ");
  if (spaceAt <= 0) return { label: "", value: entry };
  return { label: entry.slice(0, spaceAt), value: entry.slice(spaceAt + 1) };
}

/** A labelled amount, half of a before/after pair. */
function Figure({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  /** The "before" half of a pair, de-emphasised next to the current figure. */
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </span>
      <span
        className={cn(
          "truncate font-mono text-[13px]",
          muted
            ? "text-neutral-500 line-through"
            : "font-medium text-neutral-900",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function CommissionSheet({
  commission,
  product,
  listHref,
  renderedAt,
}: {
  commission: SheetCommission;
  product: { id: string; slug: string };
  listHref: string;
  /** When the page read this commission, as an ISO string. Bound into Mark paid. */
  renderedAt: string;
}) {
  const router = useRouter();

  const flag =
    commission.status === COMMISSION_STATUS.FLAGGED
      ? flagReasonText(commission.flagReason)
      : null;
  // The same sentence covers both cases: a void states its cause, and a live
  // row a partial refund reduced states why it shrank.
  const reasonText = voidReasonText(commission.voidReason, "owner");
  const voidCause =
    commission.status === COMMISSION_STATUS.VOIDED ? reasonText : null;
  const reduced =
    commission.status !== COMMISSION_STATUS.VOIDED &&
    commission.grossAmount !== null;
  // Any commission of a referral can confirm it, whatever became of this row:
  // a self referral the checks missed is only spotted later, often after a
  // void or a payout. An adjustment row belongs to no referral of its own.
  const canConfirm =
    !commission.isAdjustment && !commission.selfReferralConfirmed;
  // Once confirmed, said plainly, unless this row's void cause already says it.
  const confirmedNote =
    !commission.isAdjustment &&
    commission.selfReferralConfirmed === true &&
    !(
      commission.status === COMMISSION_STATUS.VOIDED &&
      commission.voidReason === "confirmed self-referral"
    );

  const confirmForm = (
    <form
      action={confirmFraudAction.bind(null, listHref, product, commission.id)}
    >
      <Button
        type="submit"
        size="sm"
        variant="destructive"
        className="cursor-pointer"
      >
        Confirm self referral and stop its commissions
      </Button>
    </form>
  );

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) router.push(listHref);
      }}
    >
      {/* A floating panel over the scrim, not a flush edge-to-edge pane: the
          inset, radius and border are what separate it from the page behind
          it, the same "floating panel" treatment the design system gives any
          surface that sits over the canvas rather than in it. */}
      <SheetContent className="w-[420px] gap-0 overflow-y-auto bg-card p-0 shadow-(--shadow-float) data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:h-[calc(100%-1.5rem)] data-[side=right]:rounded-(--radius) data-[side=right]:border data-[side=right]:border-neutral-200 data-[side=right]:sm:max-w-[420px]">
        <SheetHeader className="gap-1 border-b border-neutral-200 bg-neutral-50 px-5 py-4 pr-12">
          <SheetTitle className="text-xl font-medium tabular-nums text-neutral-900">
            {commission.amount}
          </SheetTitle>
          <SheetDescription className="truncate">
            {commission.affiliate} · {commission.createdLabel}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-5 py-5">
          {/* The owner is being asked to accuse someone: the evidence comes
              before the confirm/dismiss controls, never after. */}
          {flag && (
            <div className="flex flex-col gap-3 rounded-(--radius) border border-status-warning/30 bg-status-warning-bg px-4 py-3.5">
              <p className="text-sm font-medium text-neutral-900">
                {flag.title}
              </p>
              {flag.evidence.length > 0 && (
                // Stacked, not side by side: these are the exact values the
                // accusation rests on, so they are never shortened. One under
                // the other on a shared left edge also makes the pair easier
                // to compare character by character than two columns would.
                <dl className="flex flex-col gap-2">
                  {flag.evidence.map((entry) => {
                    const { label, value } = splitEvidence(entry);
                    return (
                      <div key={entry} className="flex items-baseline gap-3">
                        <dt className="w-16 shrink-0 text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
                          {label}
                        </dt>
                        <dd className="min-w-0 flex-1 font-mono text-[13px] leading-snug font-medium break-all text-neutral-900">
                          {value}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          )}

          {voidCause && (
            <div className="flex flex-col gap-0.5 rounded-(--radius) border border-neutral-200 bg-neutral-50 px-4 py-3.5">
              <p className="text-sm text-neutral-900">{voidCause}</p>
              {commission.voidedLabel && (
                <p className="text-[13px] text-muted-foreground">
                  {commission.voidedLabel}
                </p>
              )}
            </div>
          )}

          {reduced && commission.grossAmount && (
            <div className="flex flex-col gap-3 rounded-(--radius) border border-neutral-200 bg-neutral-50 px-4 py-3.5">
              <p className="text-sm text-neutral-900">{reasonText}</p>
              <div className="grid grid-cols-2 gap-4">
                <Figure
                  label="What it was"
                  value={commission.grossAmount}
                  muted
                />
                <Figure label="What it is now" value={commission.amount} />
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Line label="Affiliate">{commission.affiliateEmail}</Line>
            <Line label="Status">
              {commission.disputed
                ? commission.status === COMMISSION_STATUS.FLAGGED
                  ? "Flagged, disputed"
                  : "Disputed"
                : STATUS_LABELS[commission.status]}
            </Line>
            {commission.status === COMMISSION_STATUS.PENDING ? (
              <p className="text-[13px] text-muted-foreground">
                {commission.disputed
                  ? "Sale confirmed. Payout is paused while the dispute is open."
                  : `Sale confirmed. Expected availability is ${commission.payableLabel}, subject to review.`}
              </p>
            ) : commission.status !== COMMISSION_STATUS.VOIDED ? (
              <Line label="Payable on">{commission.payableLabel}</Line>
            ) : null}
            <Line label="Sale">
              {commission.reference ? (
                commission.reference.href ? (
                  <a
                    href={commission.reference.href}
                    target="_blank"
                    rel="noreferrer"
                    className="cursor-pointer font-mono text-xs underline underline-offset-2"
                  >
                    {commission.reference.text}
                  </a>
                ) : (
                  <span className="font-mono text-xs">
                    {commission.reference.text}
                  </span>
                )
              ) : (
                <span className="text-muted-foreground">No reference</span>
              )}
            </Line>
            {commission.paymentProvider && (
              <Line label="Provider">{commission.paymentProvider}</Line>
            )}
            {commission.saleAmount && (
              <Line label="Sale before fee">{commission.saleAmount}</Line>
            )}
            {commission.providerFeeSource && commission.providerFeeAmount && (
              <Line label="Processing fee">
                {commission.providerFeeAmount} (
                {commission.providerFeeSource === "ACTUAL"
                  ? "actual"
                  : "fallback estimate"}
                )
              </Line>
            )}
            {commission.cryptoAmount && commission.cryptoCurrency && (
              <Line label="Crypto paid">
                <span className="font-mono text-xs">
                  {commission.cryptoAmount}{" "}
                  {commission.cryptoCurrency.toUpperCase()}
                  {commission.cryptoNetwork
                    ? ` · ${commission.cryptoNetwork.toUpperCase()}`
                    : ""}
                </span>
              </Line>
            )}
            <Line label="Click">{commission.clickLabel}</Line>
            {commission.linkLabel && (
              <Line label="Link">
                <span className="font-mono text-xs">
                  {commission.linkLabel}
                </span>
              </Line>
            )}
          </div>

          {commission.status === COMMISSION_STATUS.PAYABLE && (
            <form
              action={markPaidAction.bind(
                null,
                listHref,
                product,
                [{ id: commission.id, amount: commission.payTotal }],
                renderedAt,
              )}
            >
              <Button type="submit" size="sm" className="cursor-pointer">
                Mark paid
              </Button>
            </form>
          )}

          {commission.status === COMMISSION_STATUS.PENDING && (
            // A reason, because a voided commission is read months later by
            // somebody asking why an affiliate was not paid for a sale.
            <form
              action={voidAction.bind(null, listHref, product, commission.id)}
              className="flex flex-col gap-2"
            >
              <Label htmlFor="void-reason" className="text-sm font-medium">
                Reason for void
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="void-reason"
                  name="reason"
                  placeholder="Add a note"
                  maxLength={200}
                  className="flex-1"
                  autoComplete="off"
                />
                <Button
                  type="submit"
                  size="lg"
                  variant="secondary"
                  className="cursor-pointer"
                >
                  Void
                </Button>
              </div>
            </form>
          )}

          {commission.status === COMMISSION_STATUS.FLAGGED && (
            <div className="flex gap-2">
              {canConfirm && confirmForm}
              <form
                action={dismissFlagAction.bind(
                  null,
                  listHref,
                  product,
                  commission.id,
                )}
              >
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  className="cursor-pointer"
                >
                  Dismiss flag
                </Button>
              </form>
            </div>
          )}

          {commission.status === COMMISSION_STATUS.PAID && (
            <p className="text-sm text-muted-foreground">
              {commission.stateLabel}
            </p>
          )}

          {commission.status !== COMMISSION_STATUS.FLAGGED &&
            canConfirm &&
            confirmForm}

          {confirmedNote && (
            <p className="text-sm text-muted-foreground">
              Self referral confirmed
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
