import { Wallet } from "lucide-react";
import { formatDate } from "@/lib/format";
import { Page, PageTitle, Tiles, Section } from "@/components/dashboard/Page";
import { StatTile } from "@/components/dashboard/StatTile";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { PayoutDetailsForm } from "../PayoutDetailsForm";

/**
 * What being paid looks like when Supaffi never touches the money: the three
 * totals, the details the merchant pays against, and a history that is derived
 * rather than a ledger of transfers, because no transfer runs through this
 * product.
 *
 * Presentational: the page reads the database and hands the result over, so the
 * screen can be rendered in the dev kit with fixtures.
 */

/**
 * One row per payout, at the moment it was made. Two payouts made the same
 * day are two rows, each with its own time, because they were two transfers.
 * A row can carry more than one source currency. Its estimated dashboard-
 * currency total is shown separately from the original amounts and currencies.
 */
type PaymentDisplay = {
  paidAt: Date;
  count: number;
  estimate: string | null;
  sourceAmounts: string[];
  unconverted: string[];
};

type MoneyDisplay = {
  value: string;
  hint: string | null;
  hasAmount: boolean;
};

function PaymentRows({ payments }: { payments: PaymentDisplay[] }) {
  return (
    <ul className="flex flex-col">
      {payments.map((payment) => {
        return (
          <li
            key={payment.paidAt.toISOString()}
            className="flex items-center gap-3 border-b border-neutral-200 py-3 last:border-0"
          >
            <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
              {formatDate(payment.paidAt)}
            </span>
            {/* Dropped on a phone rather than truncated to nothing: it is the
                least of the three things in the row. */}
            <span className="hidden min-w-0 flex-1 truncate text-[13px] text-muted-foreground tabular-nums sm:block">
              {payment.count} commission{payment.count === 1 ? "" : "s"}
            </span>
            <span className="flex-1 sm:hidden" />
            <span className="flex shrink-0 flex-col items-end">
              {payment.estimate ? (
                <span className="text-[15px] font-medium text-neutral-900 tabular-nums">
                  {payment.estimate}
                </span>
              ) : null}
              <span
                className={
                  payment.estimate
                    ? "text-right text-[11px] text-muted-foreground tabular-nums"
                    : "text-[15px] font-medium text-neutral-900 tabular-nums"
                }
              >
                Paid in {payment.sourceAmounts.join(" · ")}
              </span>
              {payment.unconverted.length > 0 && (
                <span className="text-right text-[11px] text-muted-foreground tabular-nums">
                  Not converted: {payment.unconverted.join(" · ")}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export type PayoutsView = {
  merchantName: string;
  payoutDetails: string | null;
  payments: PaymentDisplay[];
  pending: MoneyDisplay;
  payable: MoneyDisplay;
  paid: MoneyDisplay;
  rateNote: string;
};

export function PayoutsScreen({
  merchantName,
  payoutDetails,
  payments,
  pending,
  payable,
  paid,
  rateNote,
}: PayoutsView) {
  return (
    <Page>
      <PageTitle title="Payouts" subtitle={rateNote} />

      {/* The same three words the ledger's badges use, so one state is one word
          everywhere on this dashboard. */}
      <Tiles columns={3}>
        <StatTile
          label="Pending"
          value={pending.value}
          hint={pending.hint ?? undefined}
        />
        <StatTile
          label="Payable"
          value={payable.value}
          hint={payable.hint ?? undefined}
          tone={payable.hasAmount ? "accent" : "neutral"}
        />
        <StatTile
          label="Paid"
          value={paid.value}
          hint={paid.hint ?? undefined}
          tone={paid.hasAmount ? "success" : "neutral"}
        />
      </Tiles>

      {/* Content sized, not stretched to the viewport: two cards holding a
          textarea and a handful of dates have nothing to fill 500px with, and
          air under a page reads better than air inside a card. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <PayoutDetailsForm initial={payoutDetails ?? ""} />

        <Section
          title="Payment history"
          // The one fact this screen has to carry: the money comes from the
          // merchant, not from here, so nobody waits on a transfer that is
          // never coming.
          actions={
            // Dropped on a phone: beside a title that has already wrapped it
            // reads as a cramped third column, and the empty state carries the
            // same fact where it is needed most.
            <span className="hidden text-right text-[13px] text-balance text-muted-foreground sm:block">
              Paid by {merchantName} directly
            </span>
          }
          scroll
          className="max-h-[26rem]"
        >
          {payments.length === 0 ? (
            <EmptyState
              icon={<Wallet />}
              title="No payments yet"
              body={`A payment appears here once ${merchantName} marks your commissions paid.`}
            />
          ) : (
            <PaymentRows payments={payments} />
          )}
        </Section>
      </div>
    </Page>
  );
}
