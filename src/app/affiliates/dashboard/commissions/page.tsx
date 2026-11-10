import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAffiliate } from "@/lib/affiliateAuth";
import { getAffiliateDisplaySettings } from "@/lib/affiliateDisplaySettings";
import { formatDate, formatMoney } from "@/lib/format";
import {
  convertCurrencyTotals,
  formatCurrencyAtMinorUnitPrecision,
  formatReferenceRateLabel,
  getEcbReferenceRates,
} from "@/lib/currency";
import {
  AFFILIATE_COMMISSION_STATUSES,
  COMMISSION_STATUS,
} from "@/lib/commissionStatus";
import {
  listAffiliateCommissions,
  getAffiliateCommissionTotals,
  listAffiliateCommissionFilterOptions,
  getAffiliateCommissionDetail,
  getAffiliatePayoutRecord,
  type AffiliateCommissionFilters,
  type AffiliateCommissionStatus,
  type AffiliateCommissionDetail,
} from "@/lib/affiliate";
import { Page, PageTitle, Section } from "@/components/dashboard/Page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  CommissionLedger,
  STATUS_LABELS,
  toLedgerRow,
  type LedgerRow,
} from "./CommissionLedger";
import { AffiliateCommissionSheet } from "./AffiliateCommissionSheet";
import { AffiliateCommissionFilters as CommissionFilters } from "./AffiliateCommissionFilters";

/**
 * Every commission, and why each one is the amount it is.
 *
 * The owner's commissions screen minus everything an affiliate cannot do: no
 * checkboxes, no bulk actions, no flag controls, no payment references. Same
 * tabs over one ledger, same card, so the two sides read as one product.
 */

const PAGE_SIZE = 25;

const STATUSES: readonly AffiliateCommissionStatus[] =
  AFFILIATE_COMMISSION_STATUSES;

function parseStatus(
  raw: string | undefined,
): AffiliateCommissionStatus | null {
  const upper = raw?.toUpperCase();
  return STATUSES.find((s) => s === upper) ?? null;
}

function sanitizePage(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 1_000_000);
}

function parseUtcCalendarDate(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== raw
  ) {
    return null;
  }
  return date;
}

function detailStateLabel(detail: AffiliateCommissionDetail): string {
  switch (detail.status) {
    case COMMISSION_STATUS.PENDING:
      if (detail.reviewHeld) return "Under review; payout is paused";
      if (detail.payoutHold) {
        return `Below minimum: ${formatMoney(detail.payoutHold.eligibleBalance, detail.currency)} eligible; ${formatMoney(detail.payoutHold.remaining, detail.currency)} still needed`;
      }
      return detail.payableAt.getTime() <= Date.now()
        ? "Checking availability"
        : `Available ${formatDate(detail.payableAt)}`;
    case COMMISSION_STATUS.PAYABLE:
      return "Ready to pay";
    case COMMISSION_STATUS.PAID:
      return detail.paidAt ? `Paid ${formatDate(detail.paidAt)}` : "Paid";
    case COMMISSION_STATUS.VOIDED:
      return "Voided";
  }
}

export default async function AffiliateCommissionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    page?: string;
    commission?: string;
    payout?: string;
    dateFrom?: string;
    dateTo?: string;
    link?: string;
  }>;
}) {
  const { affiliateId, merchant } = await requireAffiliate();
  const query = await searchParams;
  const payoutId = query.payout?.trim() || null;
  const status = payoutId ? null : parseStatus(query.status);
  const page = sanitizePage(query.page);
  const fromDate = parseUtcCalendarDate(query.dateFrom);
  const throughDate = parseUtcCalendarDate(query.dateTo);
  const invalidDateFilter =
    !payoutId &&
    ((Boolean(query.dateFrom) && fromDate === null) ||
      (Boolean(query.dateTo) && throughDate === null) ||
      (fromDate !== null &&
        throughDate !== null &&
        fromDate.getTime() > throughDate.getTime()));
  const linkOptions = payoutId
    ? []
    : await listAffiliateCommissionFilterOptions(affiliateId);
  const linkId = linkOptions.some((link) => link.id === query.link)
    ? (query.link ?? null)
    : null;
  const dateToExclusive = throughDate ? new Date(throughDate) : null;
  if (dateToExclusive) {
    dateToExclusive.setUTCDate(dateToExclusive.getUTCDate() + 1);
  }
  const filters: AffiliateCommissionFilters = payoutId
    ? {}
    : {
        createdAtGte: invalidDateFilter ? null : fromDate,
        createdAtLt: invalidDateFilter ? null : dateToExclusive,
        linkId,
      };
  const anyFilterActive = Boolean(
    filters.createdAtGte ||
    filters.createdAtLt ||
    filters.linkId ||
    invalidDateFilter,
  );

  const [
    { rows: sourceRows, total },
    totals,
    displaySettings,
    rates,
    detail,
    payoutRecord,
  ] = await Promise.all([
    invalidDateFilter
      ? Promise.resolve({ rows: [], total: 0 })
      : listAffiliateCommissions(affiliateId, {
          page,
          pageSize: PAGE_SIZE,
          status,
          payoutId,
          filters,
        }),
    invalidDateFilter
      ? Promise.resolve(
          AFFILIATE_COMMISSION_STATUSES.map((status) => ({ status, count: 0 })),
        )
      : getAffiliateCommissionTotals(affiliateId, filters),
    getAffiliateDisplaySettings(affiliateId, merchant.id),
    getEcbReferenceRates(),
    query.commission
      ? getAffiliateCommissionDetail(
          affiliateId,
          merchant.id,
          query.commission,
          payoutId,
        )
      : Promise.resolve(null),
    payoutId
      ? getAffiliatePayoutRecord(affiliateId, payoutId)
      : Promise.resolve(null),
  ]);
  const currency = displaySettings?.effectiveCurrency ?? "eur";
  const rows = sourceRows.map((row) => {
    const converted = convertCurrencyTotals(
      [{ currency: row.currency, total: row.amount }],
      currency,
      rates,
    );
    const convertedSale =
      row.saleAmount === null
        ? null
        : convertCurrencyTotals(
            [{ currency: row.currency, total: row.saleAmount }],
            currency,
            rates,
          );
    return {
      ...row,
      convertedAmount:
        converted.isEstimate && converted.total !== null
          ? `≈ ${formatCurrencyAtMinorUnitPrecision(converted.total, currency)}`
          : null,
      convertedSaleAmount:
        convertedSale?.isEstimate && convertedSale.total !== null
          ? `≈ ${formatCurrencyAtMinorUnitPrecision(convertedSale.total, currency)}`
          : null,
      conversionUnavailable: converted.total === null,
    };
  });
  const estimated = rows.some((row) => row.convertedAmount !== null);
  const missingRates = [
    ...new Set(
      rows
        .filter((row) => row.conversionUnavailable)
        .map((row) => row.currency),
    ),
  ].sort();
  const rateNote = [
    `Dashboard currency: ${currency.toUpperCase()}`,
    estimated && rates.rateDate
      ? formatReferenceRateLabel(rates.rateDate)
      : null,
    missingRates.length
      ? `No ECB rate for ${missingRates.join(", ")}; source amounts remain visible.`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Every href keeps the status filter that is already on and changes one
  // thing, so paging through a filtered view does not silently drop it.
  function hrefWith(changes: Record<string, string | null>): string {
    const params = new URLSearchParams();
    const current: Record<string, string | null> = {
      payout: payoutId,
      status,
      dateFrom: payoutId || !fromDate ? null : (query.dateFrom ?? null),
      dateTo: payoutId || !throughDate ? null : (query.dateTo ?? null),
      link: payoutId ? null : linkId,
      page: page > 1 ? String(page) : null,
      ...changes,
    };
    for (const [key, value] of Object.entries(current)) {
      if (value) params.set(key, value);
    }
    const search = params.toString();
    return search ? `?${search}` : "?";
  }

  // Same hole as the owner ledger: a page number past the end rendered an
  // empty ledger under a label counting rows that are not there.
  if (page > totalPages) {
    const search = hrefWith({
      page: totalPages > 1 ? String(totalPages) : null,
    });
    redirect(
      `/affiliates/dashboard/commissions${search === "?" ? "" : search}`,
    );
  }

  const allCount = totals.reduce((sum, t) => sum + t.count, 0);
  const countsByStatus = new Map(
    totals.map((total) => [total.status, total.count]),
  );
  const tabStatuses = [
    COMMISSION_STATUS.PAYABLE,
    COMMISSION_STATUS.PENDING,
    COMMISSION_STATUS.PAID,
    COMMISSION_STATUS.VOIDED,
  ] as const satisfies readonly AffiliateCommissionStatus[];
  const tabs: {
    label: string;
    count: number;
    status: AffiliateCommissionStatus | null;
  }[] = [
    { label: "All", count: allCount, status: null },
    ...tabStatuses.map((tabStatus) => ({
      label: STATUS_LABELS[tabStatus],
      count: countsByStatus.get(tabStatus) ?? 0,
      status: tabStatus,
    })),
  ];

  const ledgerRows: LedgerRow[] = rows.map((row) => ({
    ...toLedgerRow(row),
    href: hrefWith({ commission: row.id }),
  }));

  const detailView = detail
    ? {
        amount: `${formatMoney(detail.amount, detail.currency)} ${detail.currency.toUpperCase()}`,
        saleAmount:
          detail.saleAmount === null
            ? null
            : `${formatMoney(detail.saleAmount, detail.currency)} ${detail.currency.toUpperCase()}`,
        grossAmount:
          detail.grossAmount === null
            ? null
            : `${formatMoney(detail.grossAmount, detail.currency)} ${detail.currency.toUpperCase()}`,
        status: detail.status,
        stateLabel: detailStateLabel(detail),
        createdLabel: formatDate(detail.createdAt),
        payableLabel: formatDate(detail.payableAt),
        paidLabel: detail.paidAt ? formatDate(detail.paidAt) : null,
        voidedLabel: detail.voidedAt ? formatDate(detail.voidedAt) : null,
        linkCode: detail.linkCode,
        isAdjustment: detail.isAdjustment,
        voidReason: detail.voidReason,
        paymentProvider: detail.paymentProvider,
        reviewHeld: detail.reviewHeld,
        payoutHold: detail.payoutHold
          ? {
              eligibleBalance: formatMoney(
                detail.payoutHold.eligibleBalance,
                detail.currency,
              ),
              minimum: formatMoney(detail.payoutHold.minimum, detail.currency),
              remaining: formatMoney(
                detail.payoutHold.remaining,
                detail.currency,
              ),
            }
          : null,
        payoutRecord: detail.payoutRecord
          ? {
              total: `${formatMoney(detail.payoutRecord.total, detail.payoutRecord.currency)} ${detail.payoutRecord.currency.toUpperCase()}`,
              paidLabel: formatDate(detail.payoutRecord.paidAt),
              programName: detail.payoutRecord.programName,
              isException: detail.payoutRecord.isException,
            }
          : null,
      }
    : null;

  const unselected = hrefWith({ commission: null });
  const listHref = `/affiliates/dashboard/commissions${unselected === "?" ? "" : unselected}`;

  const statusTabs = (
    <Tabs value={status ?? "all"}>
      <TabsList variant="line">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.label}
            value={tab.status ?? "all"}
            render={
              <Link
                href={hrefWith({ status: tab.status, page: null })}
                className="cursor-pointer"
              />
            }
          >
            {tab.label}
            <span className="ml-1.5 text-muted-foreground tabular-nums">
              {tab.count}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  const payoutSubtitle = payoutRecord
    ? `${payoutRecord.programName} · ${formatDate(payoutRecord.paidAt)} · ${formatMoney(payoutRecord.total, payoutRecord.currency)} ${payoutRecord.currency.toUpperCase()} · ${payoutRecord.commissionCount} commission${payoutRecord.commissionCount === 1 ? "" : "s"}`
    : null;

  return (
    <Page>
      <PageTitle
        title={payoutId ? "Payout commissions" : "Commissions"}
        subtitle={
          payoutId
            ? payoutSubtitle
              ? `${payoutSubtitle} · ${rateNote}`
              : "This payout was not found or is no longer available."
            : rateNote
        }
        actions={
          payoutId ? (
            <Link
              href="/affiliates/dashboard/payouts"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Back to payouts
            </Link>
          ) : (
            <div className="hidden md:block">{statusTabs}</div>
          )
        }
      />

      {/* Keep the title and status tabs together on wide screens, matching the
          owner dashboard. On phones, give the tabs a scrollable row of their
          own so they never crowd the heading. */}
      {!payoutId && (
        <div className="-mx-8 shrink-0 overflow-x-auto px-8 md:hidden">
          {statusTabs}
        </div>
      )}

      {/* Flush and clipped: the rows are the card, and the table scrolls
          inside it so the page never does. */}
      {payoutId && !payoutRecord ? (
        <Section title="Payout details">
          <p className="text-sm text-muted-foreground">
            This payout is unavailable. Return to payouts and choose a payment
            from your history.
          </p>
        </Section>
      ) : (
        <>
          <Section
            title={payoutId ? "Commissions in this payout" : undefined}
            flush
            scroll
            className="overflow-hidden"
          >
            {!payoutId && (
              <CommissionFilters
                key={`${query.dateFrom ?? ""}:${query.dateTo ?? ""}:${linkId ?? ""}`}
                links={linkOptions}
                dateFrom={fromDate ? (query.dateFrom ?? "") : ""}
                dateTo={throughDate ? (query.dateTo ?? "") : ""}
                linkId={linkId}
                anyFilterActive={anyFilterActive}
                invalidDateFilter={invalidDateFilter}
              />
            )}
            {!invalidDateFilter && (
              <CommissionLedger
                rows={ledgerRows}
                filtered={
                  status !== null || payoutId !== null || anyFilterActive
                }
              />
            )}
          </Section>

          <TablePagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            hrefFor={(p) => hrefWith({ page: p > 1 ? String(p) : null })}
          />
        </>
      )}

      {detailView && (
        <AffiliateCommissionSheet commission={detailView} listHref={listHref} />
      )}
    </Page>
  );
}
