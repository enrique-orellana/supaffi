"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { Page, PageTitle, Section, Tiles } from "@/components/dashboard/Page";
import { StatTile } from "@/components/dashboard/StatTile";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PayoutHistoryTable, type PaymentDisplay } from "./PayoutHistoryTable";

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
  const [selectedProgram, setSelectedProgram] = useState(filters.program);
  const anyFilterActive = Boolean(
    filters.dateFrom || filters.dateTo || filters.program || selectedProgram,
  );
  const selectedProgramName = programOptions.find(
    (program) => program.id === selectedProgram,
  )?.name;

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

      <Section flush>
        <form
          method="get"
          action="/affiliates/dashboard/payouts"
          aria-label="Filter payment history"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-5 py-3"
        >
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>From</span>
            <Input
              key={`from:${filters.dateFrom}`}
              type="date"
              name="dateFrom"
              aria-label="From date"
              defaultValue={filters.dateFrom}
              max={filters.dateTo || undefined}
              className="h-8 w-40 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>To</span>
            <Input
              key={`to:${filters.dateTo}`}
              type="date"
              name="dateTo"
              aria-label="To date"
              defaultValue={filters.dateTo}
              min={filters.dateFrom || undefined}
              className="h-8 w-40 text-sm"
            />
          </label>
          {programOptions.length >= 2 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Program</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={`Program: ${selectedProgramName ?? "All programs"}`}
                      className="cursor-pointer justify-between gap-1.5"
                    />
                  }
                >
                  <span
                    className={
                      selectedProgramName
                        ? "font-medium"
                        : "text-muted-foreground"
                    }
                  >
                    {selectedProgramName ?? "All programs"}
                  </span>
                  <ChevronDown className="opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    className="cursor-pointer"
                    render={
                      <button
                        type="button"
                        onClick={() => setSelectedProgram("")}
                        className="w-full"
                      />
                    }
                  >
                    <Check
                      className={selectedProgram ? "opacity-0" : "opacity-100"}
                    />
                    <span>All programs</span>
                  </DropdownMenuItem>
                  {programOptions.map((program) => (
                    <DropdownMenuItem
                      key={program.id}
                      className="cursor-pointer"
                      render={
                        <button
                          type="button"
                          onClick={() => setSelectedProgram(program.id)}
                          className="w-full"
                        />
                      }
                    >
                      <Check
                        className={
                          selectedProgram === program.id
                            ? "opacity-100"
                            : "opacity-0"
                        }
                      />
                      <span>{program.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          <input type="hidden" name="program" value={selectedProgram} />
          <Button type="submit" variant="outline">
            Apply
          </Button>
          {anyFilterActive && (
            <Button
              variant="ghost"
              className="cursor-pointer text-muted-foreground"
              nativeButton={false}
              onClick={() => setSelectedProgram("")}
              render={<Link href="/affiliates/dashboard/payouts" />}
            >
              <X />
              Clear
            </Button>
          )}
          <h2 className="ml-auto shrink-0 whitespace-nowrap text-sm font-medium">
            Payment history
          </h2>
        </form>
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
