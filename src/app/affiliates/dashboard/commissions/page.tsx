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
  getAffiliateCommissionDetail,
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

function detailStateLabel(detail: AffiliateCommissionDetail): string {
  switch (detail.status) {
    case COMMISSION_STATUS.PENDING:
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
  }>;
}) {
  const { affiliateId, merchant } = await requireAffiliate();
  const query = await searchParams;
  const status = parseStatus(query.status);
  const page = sanitizePage(query.page);

  const [{ rows: sourceRows, total }, totals, displaySettings, rates, detail] =
    await Promise.all([
      listAffiliateCommissions(affiliateId, {
        page,
        pageSize: PAGE_SIZE,
        status,
      }),
      getAffiliateCommissionTotals(affiliateId),
      getAffiliateDisplaySettings(affiliateId, merchant.id),
      getEcbReferenceRates(),
      query.commission
        ? getAffiliateCommissionDetail(
            affiliateId,
            merchant.id,
            query.commission,
          )
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
      status,
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
  const tabs: {
    label: string;
    count: number;
    status: AffiliateCommissionStatus | null;
  }[] = [
    { label: "All", count: allCount, status: null },
    ...totals.map((t) => ({
      label: STATUS_LABELS[t.status],
      count: t.count,
      status: t.status,
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

  return (
    <Page>
      <PageTitle
        title="Commissions"
        subtitle={rateNote}
        actions={<div className="hidden md:block">{statusTabs}</div>}
      />

      {/* The same tabs get their own row on a phone, where five of them plus a
          heading do not fit on one line and would push the page sideways. */}
      <div className="-mx-8 shrink-0 overflow-x-auto px-8 md:hidden">
        {statusTabs}
      </div>

      {/* Flush and clipped: the rows are the card, and the table scrolls
          inside it so the page never does. */}
      <Section flush scroll className="overflow-hidden">
        <CommissionLedger rows={ledgerRows} filtered={status !== null} />
      </Section>

      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        hrefFor={(p) => hrefWith({ page: p > 1 ? String(p) : null })}
      />

      {detailView && (
        <AffiliateCommissionSheet commission={detailView} listHref={listHref} />
      )}
    </Page>
  );
}
