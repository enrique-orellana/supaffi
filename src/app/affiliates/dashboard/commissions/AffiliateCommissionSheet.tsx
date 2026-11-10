"use client";

import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AffiliateCommissionStatus } from "@/lib/affiliate";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, STATUS_STYLES } from "./CommissionLedger";

export type AffiliateCommissionDetailView = {
  amount: string;
  saleAmount: string | null;
  affiliateCommissionRate?: string | null;
  processorFeeAmount?: string | null;
  processorFee?: string | null;
  processorFeeSource?: "ACTUAL" | "FALLBACK" | null;
  grossAmount: string | null;
  status: AffiliateCommissionStatus;
  stateLabel: string;
  createdLabel: string;
  payableLabel: string;
  paidLabel: string | null;
  voidedLabel: string | null;
  linkCode: string | null;
  linkDestinationPath?: string | null;
  isAdjustment: boolean;
  /** Already sanitized for the affiliate audience by the server. */
  voidReason: string | null;
  paymentProvider: string | null;
  reviewHeld: boolean;
  payoutHold: {
    eligibleBalance: string;
    minimum: string;
    remaining: string;
  } | null;
  payoutRecord: {
    total: string;
    paidLabel: string;
    programName: string;
    isException: boolean;
  } | null;
};

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 py-3 last:border-b-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium text-foreground">
        {children}
      </dd>
    </div>
  );
}

export function AffiliateCommissionSheet({
  commission,
  listHref,
}: {
  commission: AffiliateCommissionDetailView;
  listHref: string;
}) {
  const router = useRouter();
  const isVoided = commission.status === COMMISSION_STATUS.VOIDED;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) router.push(listHref);
      }}
    >
      <SheetContent className="w-[420px] gap-0 overflow-y-auto bg-card p-0 data-[side=right]:sm:max-w-[420px]">
        <SheetHeader className="gap-1 border-b border-border bg-muted/30 px-5 py-4 pr-12">
          <SheetTitle className="text-xl font-medium tabular-nums">
            {commission.amount}
          </SheetTitle>
          <SheetDescription>
            {commission.payoutRecord?.programName
              ? `${commission.payoutRecord.programName} · Commission`
              : "Commission"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-5 py-5">
          {commission.voidReason && (
            <p className="rounded-(--radius) border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {commission.voidReason}
            </p>
          )}

          {commission.isAdjustment && (
            <p className="rounded-(--radius) border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              This is an adjustment to an earlier commission.
            </p>
          )}

          <dl>
            <DetailRow label="Status">
              <Badge className={cn(STATUS_STYLES[commission.status])}>
                {STATUS_LABELS[commission.status]}
              </Badge>
            </DetailRow>
            <DetailRow label="Commission date">
              {commission.createdLabel}
            </DetailRow>
            {commission.status === COMMISSION_STATUS.PENDING &&
              (commission.reviewHeld ? (
                <DetailRow label="Availability">
                  The merchant is reviewing this sale; payout is paused.
                </DetailRow>
              ) : commission.payoutHold ? (
                <DetailRow label="Payout minimum">
                  Mature clear commissions in this Program and currency total{" "}
                  {commission.payoutHold.eligibleBalance}. The minimum is{" "}
                  {commission.payoutHold.minimum};{" "}
                  {commission.payoutHold.remaining} more is needed.
                </DetailRow>
              ) : commission.stateLabel === "Checking availability" ? (
                <DetailRow label="Availability">
                  {commission.stateLabel}
                </DetailRow>
              ) : (
                <DetailRow label="Expected availability">
                  {commission.payableLabel}
                </DetailRow>
              ))}
            {commission.status === COMMISSION_STATUS.PAID &&
              commission.paidLabel && (
                <DetailRow label="Paid on">{commission.paidLabel}</DetailRow>
              )}
            {commission.status === COMMISSION_STATUS.PAID &&
              commission.payoutRecord && (
                <DetailRow label="Payout record">
                  {commission.payoutRecord.total}
                  {commission.payoutRecord.isException
                    ? " (below-minimum exception)"
                    : ""}
                </DetailRow>
              )}
            {isVoided && commission.voidedLabel && (
              <DetailRow label="Voided on">{commission.voidedLabel}</DetailRow>
            )}
            {commission.saleAmount && (
              <DetailRow label="Eligible sale">
                {commission.saleAmount}
              </DetailRow>
            )}
            {commission.affiliateCommissionRate && (
              <DetailRow label="Affiliate commission rate">
                {commission.affiliateCommissionRate}
              </DetailRow>
            )}
            {commission.processorFeeAmount && (
              <DetailRow label="Processor fee">
                <span>
                  {commission.processorFeeAmount}
                  {commission.processorFeeSource && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {commission.processorFeeSource === "FALLBACK"
                        ? "Estimated"
                        : "Actual"}
                    </span>
                  )}
                </span>
              </DetailRow>
            )}
            {commission.processorFee && (
              <DetailRow label="Processor fee rate">
                <span>
                  {commission.processorFee}
                  {commission.processorFeeSource && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {commission.processorFeeSource === "FALLBACK"
                        ? "Estimated"
                        : "Actual"}
                    </span>
                  )}
                </span>
              </DetailRow>
            )}
            {commission.grossAmount && (
              <DetailRow label="Before refund">
                {commission.grossAmount}
              </DetailRow>
            )}
            {commission.paymentProvider && (
              <DetailRow label="Payment provider">
                {commission.paymentProvider}
              </DetailRow>
            )}
            {commission.linkCode && (
              <DetailRow label="Affiliate link">
                <span className="font-mono">
                  {commission.linkCode} ·{" "}
                  {commission.linkDestinationPath ?? "/"}
                </span>
              </DetailRow>
            )}
          </dl>
        </div>
      </SheetContent>
    </Sheet>
  );
}
