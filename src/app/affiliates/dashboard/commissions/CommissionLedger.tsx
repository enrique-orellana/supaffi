import Link from "next/link";
import { formatMoney, formatDate } from "@/lib/format";
import { Coins } from "lucide-react";
import type {
  AffiliateCommissionRow,
  AffiliateCommissionStatus,
} from "@/lib/affiliate";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Every commission the affiliate has, whatever state it is in.
 *
 * The owner's ledger, minus what an affiliate cannot act on, and on the same
 * treatment down to the header band, the row rule and the weight of the amount
 * (src/app/dashboard/products/[product]/commissions/CommissionTable.tsx). The
 * two sides of the product are one product.
 *
 * `table-fixed` with a percentage per column: under auto layout a `max-width`
 * on a cell is ignored, so one long reason would widen the table past its card
 * instead of laying out inside it. Below `md` the table gives way to a stacked
 * list of the same rows, because six columns in the width of a phone is not a
 * table.
 */

// FLAGGED never reaches an affiliate: toDisplayStatus folds it into PENDING
// before a row gets here, so there are four states, not five. Locked to the
// owner's own mapping, so one colour means one thing on both sides.
export const STATUS_STYLES: Record<AffiliateCommissionStatus, string> = {
  [COMMISSION_STATUS.PENDING]: "bg-muted text-muted-foreground",
  [COMMISSION_STATUS.PAYABLE]: "bg-accent-50 text-accent-700",
  [COMMISSION_STATUS.PAID]: "bg-status-success-bg text-status-success",
  [COMMISSION_STATUS.VOIDED]: "bg-muted text-muted-foreground line-through",
};

export const STATUS_LABELS: Record<AffiliateCommissionStatus, string> = {
  [COMMISSION_STATUS.PENDING]: "On hold",
  [COMMISSION_STATUS.PAYABLE]: "Payable",
  [COMMISSION_STATUS.PAID]: "Paid",
  [COMMISSION_STATUS.VOIDED]: "Voided",
};

export type LedgerRow = {
  id: string;
  /** Opens this commission's affiliate-safe detail panel. */
  href?: string;
  /** Formatted on the server, so every screen shows the same date. */
  dateLabel: string;
  /** The commission's original amount and currency, unchanged in storage. */
  amount: string;
  /** The eligible sale amount in its original currency, when recorded. */
  saleAmount?: string | null;
  /** Estimated display-currency equivalent of the sale amount. */
  convertedSaleAmount?: string | null;
  /** Estimated display-currency equivalent, already formatted on the server. */
  convertedAmount: string | null;
  /** True when a reference rate was unavailable for this source currency. */
  conversionUnavailable: boolean;
  /** What the commission was before a partial refund reduced it. Null when unchanged. */
  grossAmount: string | null;
  status: AffiliateCommissionStatus;
  linkCode: string | null;
  /** A refund adjustment row an older version wrote. None are written any more. */
  isAdjustment: boolean;
  /** When the money arrives. The first thing an affiliate asks a row. */
  stateLabel: string;
  /** Already sanitized for the affiliate audience by the server. */
  voidReason: string | null;
  /** When a voided commission was voided. */
  voidedLabel: string | null;
};

/**
 * When the money arrives.
 *
 * Only ever the good half of the story: why a row was voided or reduced comes
 * from the server-sanitized affiliate-facing reason.
 */
export function commissionStateLabel(row: AffiliateCommissionRow): string {
  switch (row.status) {
    case COMMISSION_STATUS.PENDING: {
      // FLAGGED folds into PENDING and the sweep deliberately never promotes a
      // flagged row, so its payableAt can sit in the past indefinitely. Once
      // that date passes, say availability is being checked instead of showing
      // a release date that has already passed. This also keeps hidden flags
      // private while explaining why the commission is still on hold.
      if (row.payableAt.getTime() <= Date.now()) return "Checking availability";
      return `Available ${formatDate(row.payableAt)}`;
    }
    case COMMISSION_STATUS.PAYABLE:
      return "Ready to pay";
    case COMMISSION_STATUS.PAID:
      return row.paidAt ? `Paid ${formatDate(row.paidAt)}` : "Paid";
    case COMMISSION_STATUS.VOIDED:
      // The cause is the detail column's whole job here, so the state label
      // stands in only for a row whose reason was never recorded.
      return "Voided";
  }
}

/** One database row as the ledger shows it. Both screens map through this. */
export function toLedgerRow(
  row: AffiliateCommissionRow & {
    convertedAmount?: string | null;
    convertedSaleAmount?: string | null;
    conversionUnavailable?: boolean;
  },
): LedgerRow {
  return {
    id: row.id,
    dateLabel: formatDate(row.createdAt),
    amount: `${formatMoney(row.amount, row.currency)} ${row.currency.toUpperCase()}`,
    saleAmount:
      row.saleAmount === null
        ? null
        : `${formatMoney(row.saleAmount, row.currency)} ${row.currency.toUpperCase()}`,
    convertedSaleAmount: row.convertedSaleAmount ?? null,
    convertedAmount: row.convertedAmount ?? null,
    conversionUnavailable: row.conversionUnavailable ?? false,
    grossAmount: row.grossAmount
      ? formatMoney(row.grossAmount, row.currency)
      : null,
    status: row.status,
    linkCode: row.linkCode,
    isAdjustment: row.isAdjustment,
    stateLabel: commissionStateLabel(row),
    voidReason: row.voidReason,
    voidedLabel: row.voidedAt ? formatDate(row.voidedAt) : null,
  };
}

/**
 * What a voided row says: the cause, then when it happened, the same
 * `cause · date` shape the owner's ledger uses. A row that carries no reason
 * says only that it was voided rather than inventing one.
 */
function voidedDetail(cause: string | null, when: string | null): string {
  if (cause && when) return `${cause} · ${when}`;
  return cause ?? (when ? `Voided ${when}` : "Voided");
}

/**
 * The server provides affiliate-safe text; this component only decides how
 * that text fits the row.
 */
function readRow(row: LedgerRow): {
  voided: boolean;
  cause: string | null;
  reduced: boolean;
} {
  const voided = row.status === COMMISSION_STATUS.VOIDED;
  return {
    voided,
    cause: row.voidReason,
    reduced: !voided && row.grossAmount !== null,
  };
}

export function CommissionLedger({
  rows,
  filtered,
}: {
  rows: LedgerRow[];
  filtered: boolean;
}) {
  if (rows.length === 0) {
    return filtered ? (
      <EmptyState
        icon={<Coins />}
        title="Nothing matches"
        body="Pick another filter to see more."
      />
    ) : (
      <EmptyState
        icon={<Coins />}
        title="No commissions yet"
        body="A sale from one of your links shows up here the same day it happens."
      />
    );
  }

  return (
    <>
      {/* A phone is where an affiliate reads this, and five columns in 310px is
          not a table, it is overlapping text. Same row, stacked: what it is
          worth and what happened to it, in the same type and the same colours
          the table uses. */}
      <ul className="divide-y divide-neutral-200 md:hidden">
        {rows.map((row) => {
          const { voided, cause, reduced } = readRow(row);
          const content = (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-muted-foreground tabular-nums">
                  {row.dateLabel}
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span
                    className={cn(
                      "text-[15px] font-medium whitespace-nowrap tabular-nums",
                      row.isAdjustment && "text-destructive",
                      !row.isAdjustment && !voided && "text-neutral-900",
                    )}
                  >
                    {row.amount}
                  </span>
                  {reduced && row.grossAmount && (
                    <span className="text-[11px] text-neutral-500 line-through tabular-nums">
                      {row.grossAmount}
                    </span>
                  )}
                  {row.convertedAmount && (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {row.convertedAmount}
                    </span>
                  )}
                  {row.saleAmount != null && (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      Sale {row.saleAmount}
                    </span>
                  )}
                  {row.convertedSaleAmount && (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {row.convertedSaleAmount}
                    </span>
                  )}
                  {row.conversionUnavailable && (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      Not converted
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <Badge className={cn("shrink-0", STATUS_STYLES[row.status])}>
                  {STATUS_LABELS[row.status]}
                </Badge>
                <span className="min-w-0 flex-1 text-[13px] text-pretty text-muted-foreground">
                  {voided
                    ? voidedDetail(cause, row.voidedLabel)
                    : row.stateLabel}
                  {reduced && cause && (
                    <span className="block text-xs text-muted-foreground/70">
                      {cause}
                    </span>
                  )}
                </span>
              </div>
            </>
          );
          return (
            <li key={row.id} className={cn(voided && "text-muted-foreground")}>
              {row.href ? (
                <Link
                  href={row.href}
                  aria-label={`View commission details for ${row.amount}, ${row.dateLabel}`}
                  className="flex flex-col gap-1 px-4 py-3 outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {content}
                </Link>
              ) : (
                <div className="flex flex-col gap-1 px-4 py-3">{content}</div>
              )}
            </li>
          );
        })}
      </ul>

      <Table className="hidden table-fixed md:table">
        {/* The header band, hairline dividers and row padding mirror TaskCard's
            neutral bands: a header row introduces the rows under it rather than
            blending into them. */}
        <TableHeader className="sticky top-0 z-10 bg-neutral-100">
          <TableRow className="border-neutral-200 hover:bg-transparent">
            <TableHead className="h-9 w-[12%] text-[13px] font-medium text-neutral-700">
              Date
            </TableHead>
            <TableHead className="h-9 w-[17%] text-right text-[13px] font-medium text-neutral-700">
              Amount
            </TableHead>
            <TableHead className="h-9 w-[14%] text-right text-[13px] font-medium text-neutral-700">
              Sale
            </TableHead>
            <TableHead className="h-9 w-[12%] text-[13px] font-medium text-neutral-700">
              Status
            </TableHead>
            <TableHead className="h-9 w-[16%] text-[13px] font-medium text-neutral-700">
              Link
            </TableHead>
            <TableHead className="h-9 w-[29%] text-[13px] font-medium text-neutral-700">
              Detail
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="divide-y divide-neutral-200">
          {rows.map((row) => {
            const { voided, cause, reduced } = readRow(row);
            return (
              <TableRow
                key={row.id}
                className={cn(
                  "border-neutral-200 hover:bg-neutral-50",
                  row.href && "relative",
                  // Muted throughout, not only on the badge: a voided sale is the
                  // least important row on the screen and should read that way
                  // before the eye reaches the status column.
                  voided && "text-muted-foreground",
                )}
              >
                <TableCell className="align-top whitespace-nowrap text-muted-foreground tabular-nums">
                  {/* A single stretched link opens details while preserving
                      table semantics and keyboard navigation. */}
                  {row.href ? (
                    <Link
                      href={row.href}
                      aria-label={`View commission details for ${row.amount}, ${row.dateLabel}`}
                      className="cursor-pointer after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                    >
                      {row.dateLabel}
                    </Link>
                  ) : (
                    row.dateLabel
                  )}
                </TableCell>
                <TableCell className="text-right align-top">
                  {/* The heaviest thing in the row: this screen's whole subject
                    is money, and the currency is carried once, on the figure
                    itself. */}
                  <span
                    className={cn(
                      "block text-[15px] font-medium whitespace-nowrap tabular-nums",
                      row.isAdjustment && "text-destructive",
                      !row.isAdjustment && !voided && "text-neutral-900",
                    )}
                  >
                    {row.amount}
                  </span>
                  {/* What it was before the refund, struck through under what it
                    is now: a reduced row has to show both figures or the
                    affiliate is left doing the subtraction. */}
                  {reduced && row.grossAmount && (
                    <span className="block text-[11px] text-neutral-500 line-through tabular-nums">
                      {row.grossAmount}
                    </span>
                  )}
                  {row.convertedAmount && (
                    <span className="block text-[11px] font-normal text-muted-foreground">
                      {row.convertedAmount}
                    </span>
                  )}
                  {row.conversionUnavailable && (
                    <span className="block text-[11px] font-normal text-muted-foreground">
                      Not converted
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right align-top whitespace-nowrap tabular-nums">
                  {row.saleAmount == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      <span className="block text-[13px] text-neutral-700">
                        {row.saleAmount}
                      </span>
                      {row.convertedSaleAmount && (
                        <span className="block text-[11px] text-muted-foreground">
                          {row.convertedSaleAmount}
                        </span>
                      )}
                    </>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  <Badge className={STATUS_STYLES[row.status]}>
                    {STATUS_LABELS[row.status]}
                  </Badge>
                </TableCell>
                <TableCell className="align-top">
                  <span className="block truncate font-mono text-[13px] text-muted-foreground">
                    {row.linkCode ?? "Deleted"}
                  </span>
                </TableCell>
                <TableCell className="align-top">
                  {/* Never truncated. The reason money moved is the one string on
                    this screen an affiliate cannot be asked to guess at. */}
                  <span className="block text-[13px] text-pretty text-muted-foreground">
                    {voided
                      ? voidedDetail(cause, row.voidedLabel)
                      : row.stateLabel}
                  </span>
                  {reduced && cause && (
                    <span className="block text-xs text-pretty text-muted-foreground/70">
                      {cause}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
