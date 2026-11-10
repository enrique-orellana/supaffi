"use client";

import { ChevronRight, CircleAlert, Wallet } from "lucide-react";
import Link from "next/link";
import { Page, PageTitle, Section, Tiles } from "@/components/dashboard/Page";
import { StatTile } from "@/components/dashboard/StatTile";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { PayoutHistoryTable, type PaymentDisplay } from "./PayoutHistoryTable";
import { PayoutFiltersDialog } from "./PayoutFiltersDialog";

/**
 * The payout summary and payment details an Affiliate uses to reconcile the
 * transfers they receive directly from the Merchant. Supaffi records the
 * payouts but never moves the money.
 *
 * Presentational: the page reads the database and hands the result over, so the
 * screen can be rendered in the dev kit with fixtures.
 */

type MoneyDisplay = {
  value: string;
  hint: string | null;
  hasAmount: boolean;
};

export type PayoutsView = {
  merchantName: string;
  payoutDetailsMissing: boolean;
  payments: PaymentDisplay[];
  hasPaymentHistory: boolean;
  invalidDateRange: boolean;
  programOptions: { id: string; name: string }[];
  filters: { dateFrom: string; dateTo: string; program: string };
  pending: MoneyDisplay;
  payable: MoneyDisplay;
  paid: MoneyDisplay;
  rateNote: string;
};

export function PayoutsScreen({
  merchantName,
  payoutDetailsMissing,
  payments,
  hasPaymentHistory,
  invalidDateRange,
  programOptions,
  filters,
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

      {payoutDetailsMissing && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-(--radius) border border-status-warning/30 bg-status-warning-bg p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-status-warning">
                Payout details needed
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add a payout destination so {merchantName} can send your money.
                Your commissions are still tracked.
              </p>
            </div>
          </div>
          <Link
            href="/affiliates/dashboard/settings"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-md border border-status-warning/40 px-3 text-sm font-medium text-status-warning transition-colors hover:bg-status-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Add payout details
            <ChevronRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
      )}

      <Section
        title="Payment history"
        actions={
          <PayoutFiltersDialog
            programOptions={programOptions}
            filters={filters}
          />
        }
        flush
      >
        {invalidDateRange ? (
          <p role="alert" className="px-5 py-3 text-[13px] text-status-warning">
            From date must be on or before To date. Adjust the dates and apply
            again.
          </p>
        ) : payments.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<Wallet />}
              title={
                hasPaymentHistory &&
                (filters.dateFrom || filters.dateTo || filters.program)
                  ? "No payments match these filters"
                  : "No payments yet"
              }
              body={
                hasPaymentHistory &&
                (filters.dateFrom || filters.dateTo || filters.program)
                  ? "Try a different date range or program, or clear the filters."
                  : `Once ${merchantName} marks your commissions as paid, they send the payout to you directly.`
              }
            />
          </div>
        ) : (
          <PayoutHistoryTable payments={payments} />
        )}
      </Section>
    </Page>
  );
}
