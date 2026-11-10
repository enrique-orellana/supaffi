"use client";

import { useState, useTransition } from "react";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { CopyValue } from "@/components/CopyValue";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import type { CommissionStatus } from "@/lib/commissionStatus";
import { voidReasonText, flagReasonText } from "@/lib/commissionReason";
import {
  confirmFraudAction,
  dismissFlagAction,
  voidAction,
} from "./commissionActions";

/**
 * One commission in detail, with state-appropriate actions confirmed before
 * they run.
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
  payoutHold?: {
    eligibleBalance: string;
    minimum: string;
    remaining: string;
  } | null;
  payoutRecord?: {
    id: string;
    total: string;
    paidLabel: string;
    isException: boolean;
  } | null;
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
  affiliateCommissionRatePercent?: string | null;
  providerFeePercent?: string | null;
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

const COMMISSION_ROW_ACTION = {
  CONFIRM_SELF_REFERRAL: "confirm-self-referral",
  DISMISS_FLAG: "dismiss-flag",
  VOID: "void",
} as const;

type CommissionRowAction =
  (typeof COMMISSION_ROW_ACTION)[keyof typeof COMMISSION_ROW_ACTION];

const COMMISSION_ACTION_CONFIRMATION: Record<
  CommissionRowAction,
  {
    title: string;
    description: string;
    confirmLabel: string;
    destructive: boolean;
  }
> = {
  [COMMISSION_ROW_ACTION.CONFIRM_SELF_REFERRAL]: {
    title: "Confirm this self-referral?",
    description:
      "This will void its unpaid commissions and stop future commissions tied to this referral. Already paid commissions remain unchanged.",
    confirmLabel: "Confirm self-referral",
    destructive: true,
  },
  [COMMISSION_ROW_ACTION.DISMISS_FLAG]: {
    title: "Dismiss this flag?",
    description:
      "This clears the review flag and returns the commission to normal payout checks. Any hold or dispute still applies.",
    confirmLabel: "Dismiss flag",
    destructive: false,
  },
  [COMMISSION_ROW_ACTION.VOID]: {
    title: "Void this commission?",
    description:
      "This removes the commission from unpaid balances and records the reason in its history.",
    confirmLabel: "Void commission",
    destructive: true,
  },
};

function Line({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-neutral-900">
        {children}
      </dd>
    </div>
  );
}

function DetailSection({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string | null;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-neutral-900">{title}</h3>
      <dl className="divide-y divide-neutral-200 rounded-(--radius) border border-neutral-200 bg-neutral-50/40 px-3">
        {children}
      </dl>
      {note && (
        <p className="rounded-(--radius) border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
          {note}
        </p>
      )}
    </section>
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
}: {
  commission: SheetCommission;
  product: { id: string; slug: string };
  listHref: string;
}) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState<CommissionRowAction | null>(
    null,
  );
  const [voidReason, setVoidReason] = useState("");
  const [pending, startTransition] = useTransition();

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
  const statusNote =
    commission.status === COMMISSION_STATUS.PENDING
      ? commission.disputed
        ? "Sale confirmed. Payout is paused while the dispute is open."
        : commission.payoutHold
          ? `Mature, clear commissions in this Program and currency total ${commission.payoutHold.eligibleBalance}. The minimum is ${commission.payoutHold.minimum}; ${commission.payoutHold.remaining} more is needed.`
          : `Sale confirmed. This commission is on hold until ${commission.payableLabel} for review.`
      : commission.status === COMMISSION_STATUS.PAYABLE
        ? "This commission is part of its Affiliate, Program, and currency payout group. Record the group from the Payouts page."
        : null;

  const confirmationCopy = confirmation
    ? COMMISSION_ACTION_CONFIRMATION[confirmation]
    : null;

  function submitConfirmedAction() {
    if (!confirmation) return;
    startTransition(async () => {
      if (confirmation === COMMISSION_ROW_ACTION.CONFIRM_SELF_REFERRAL) {
        await confirmFraudAction(listHref, product, commission.id);
      } else if (confirmation === COMMISSION_ROW_ACTION.DISMISS_FLAG) {
        await dismissFlagAction(listHref, product, commission.id);
      } else {
        const formData = new FormData();
        formData.set("reason", voidReason);
        await voidAction(listHref, product, commission.id, formData);
      }
    });
  }

  const confirmForm = (
    <Button
      type="button"
      size="sm"
      variant="destructive"
      className="w-full cursor-pointer whitespace-normal text-center leading-snug"
      onClick={() =>
        setConfirmation(COMMISSION_ROW_ACTION.CONFIRM_SELF_REFERRAL)
      }
    >
      Confirm self referral and stop its commissions
    </Button>
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

        <div className="flex flex-col gap-6 px-5 py-5">
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

          <DetailSection title="Commission" note={statusNote}>
            <Line label="Status">
              <span className="inline-flex rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                {commission.disputed
                  ? commission.status === COMMISSION_STATUS.FLAGGED
                    ? "Flagged · disputed"
                    : "Disputed"
                  : STATUS_LABELS[commission.status]}
              </span>
            </Line>
            {commission.affiliateCommissionRatePercent && (
              <Line label="Affiliate rate">
                {commission.affiliateCommissionRatePercent}%
              </Line>
            )}
            {commission.status === COMMISSION_STATUS.PAYABLE && (
              <Line label="Payable on">{commission.payableLabel}</Line>
            )}
            {commission.status === COMMISSION_STATUS.PAID && (
              <Line label="Paid on">{commission.stateLabel}</Line>
            )}
            {commission.payoutRecord && (
              <Line label="Payout record">
                {commission.payoutRecord.total} · recorded {commission.payoutRecord.paidLabel}
                {commission.payoutRecord.isException
                  ? " · below-minimum exception"
                  : ""}
              </Line>
            )}
            {commission.status === COMMISSION_STATUS.VOIDED &&
              commission.voidedLabel && (
                <Line label="Voided on">{commission.voidedLabel}</Line>
              )}
          </DetailSection>

          <DetailSection title="Sale">
            <Line label="Payment ref">
              {commission.reference?.href ? (
                <a
                  href={commission.reference.href}
                  target="_blank"
                  rel="noreferrer"
                  title={commission.reference.text}
                  className="block max-w-full cursor-pointer truncate font-mono text-xs underline underline-offset-2"
                >
                  {commission.reference.text}
                </a>
              ) : commission.reference ? (
                <CopyValue
                  value={commission.reference.text}
                  className="justify-end font-mono text-xs"
                />
              ) : (
                <span className="text-muted-foreground">No reference</span>
              )}
            </Line>
            {commission.paymentProvider && (
              <Line label="Provider">{commission.paymentProvider}</Line>
            )}
            {commission.saleAmount && (
              <Line label="Sale amount">{commission.saleAmount}</Line>
            )}
            {commission.providerFeePercent != null && (
              <Line label="Processor fee">
                <span>
                  {commission.providerFeePercent}%
                  {commission.providerFeeSource && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {commission.providerFeeSource === "FALLBACK"
                        ? "Estimated"
                        : "Actual"}
                    </span>
                  )}
                </span>
              </Line>
            )}
            {commission.cryptoAmount && commission.cryptoCurrency && (
              <Line label="Crypto paid">
                <span className="font-mono text-xs">
                  {commission.cryptoAmount} {commission.cryptoCurrency.toUpperCase()}
                  {commission.cryptoNetwork
                    ? ` · ${commission.cryptoNetwork.toUpperCase()}`
                    : ""}
                </span>
              </Line>
            )}
          </DetailSection>

          <DetailSection title="Referral">
            <Line label="Affiliate">{commission.affiliateEmail}</Line>
            <Line label="Click date">{commission.clickLabel}</Line>
            {commission.linkLabel && (
              <Line label="Link">
                <span className="font-mono text-xs">{commission.linkLabel}</span>
              </Line>
            )}
          </DetailSection>

          {(commission.status === COMMISSION_STATUS.PENDING ||
            commission.status === COMMISSION_STATUS.FLAGGED ||
            canConfirm ||
            confirmedNote) && (
            <section className="border-t border-neutral-200 pt-5">
              <h3 className="text-sm font-medium text-neutral-900">Actions</h3>
              <div className="mt-3 flex flex-col gap-3">
                {commission.status === COMMISSION_STATUS.PENDING && (
                  // Keep the reason beside the action, since the stored note
                  // explains this decision in the commission's history.
                  <form
                    className="flex flex-col gap-2 rounded-(--radius) border border-neutral-200 bg-neutral-50 p-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setConfirmation(COMMISSION_ROW_ACTION.VOID);
                    }}
                  >
                    <Label htmlFor="void-reason" className="text-sm font-medium">
                      Reason for void
                    </Label>
                    <Input
                      id="void-reason"
                      name="reason"
                      value={voidReason}
                      onChange={(event) => setVoidReason(event.target.value)}
                      placeholder="Add a note"
                      maxLength={200}
                      autoComplete="off"
                    />
                    <Button
                      type="submit"
                      variant="destructive"
                      className="w-full cursor-pointer"
                    >
                      Void commission
                    </Button>
                  </form>
                )}

                {commission.status === COMMISSION_STATUS.FLAGGED && (
                  <div className="flex flex-col gap-2">
                    {canConfirm && confirmForm}
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full cursor-pointer"
                      onClick={() =>
                        setConfirmation(COMMISSION_ROW_ACTION.DISMISS_FLAG)
                      }
                    >
                      Dismiss flag
                    </Button>
                  </div>
                )}

                {commission.status !== COMMISSION_STATUS.FLAGGED &&
                  canConfirm && (
                    <div className="flex flex-col gap-2 rounded-(--radius) border border-status-warning/30 bg-status-warning-bg px-3 py-3">
                      <p className="text-sm font-medium text-neutral-900">
                        Self-referral review
                      </p>
                      <p className="text-[13px] leading-relaxed text-muted-foreground">
                        Confirming this referral will void its unpaid commissions
                        and stop future commissions.
                      </p>
                      {confirmForm}
                    </div>
                  )}

                {confirmedNote && (
                  <p className="text-sm text-muted-foreground">
                    Self referral confirmed
                  </p>
                )}
              </div>
            </section>
          )}
        </div>

        <AlertDialog
          open={confirmation !== null}
          onOpenChange={(open) => {
            if (!open && !pending) setConfirmation(null);
          }}
        >
          <AlertDialogContent>
            {confirmationCopy && (
              <AlertDialogHeader>
                <AlertDialogTitle>{confirmationCopy.title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmationCopy.description}
                  {confirmation === COMMISSION_ROW_ACTION.VOID && (
                    <span className="mt-2 block">
                      Reason: {voidReason.trim() || "voided by owner"}
                    </span>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                type="button"
                variant={
                  confirmationCopy?.destructive ? "destructive" : "secondary"
                }
                disabled={pending}
                onClick={submitConfirmedAction}
              >
                {pending
                  ? "Working"
                  : (confirmationCopy?.confirmLabel ?? "Confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
