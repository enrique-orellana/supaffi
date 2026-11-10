import { requireAffiliate } from "@/lib/affiliateAuth";
import { getAffiliateDisplaySettings } from "@/lib/affiliateDisplaySettings";
import {
  convertCurrencyTotals,
  formatCurrencyAtMinorUnitPrecision,
  formatReferenceRateLabel,
  getEcbReferenceRates,
} from "@/lib/currency";
import { getAffiliateMetrics } from "@/lib/analytics";
import {
  getAffiliatePayoutDetails,
  listAffiliatePayments,
} from "@/lib/affiliate";
import { PayoutsScreen } from "./PayoutsScreen";

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

/**
 * What being paid looks like when Supaffi never touches the money: the
 * totals that answer "how much, and when", the payout details the merchant
 * pays against, and a history that is derived rather than a ledger of
 * transfers, because no transfer runs through this product.
 */
export default async function AffiliatePayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{
    dateFrom?: string;
    dateTo?: string;
    program?: string;
  }>;
}) {
  const { affiliateId, merchant } = await requireAffiliate();
  const query = await searchParams;

  const [metrics, payoutDetails, sourcePayments, displaySettings, rates] =
    await Promise.all([
      getAffiliateMetrics(affiliateId),
      getAffiliatePayoutDetails(affiliateId),
      listAffiliatePayments(affiliateId),
      getAffiliateDisplaySettings(affiliateId, merchant.id),
      getEcbReferenceRates(),
    ]);
  const fromDate = parseUtcCalendarDate(query.dateFrom);
  const throughDate = parseUtcCalendarDate(query.dateTo);
  const invalidDateRange =
    fromDate !== null &&
    throughDate !== null &&
    fromDate.getTime() > throughDate.getTime();
  const toDateExclusive = throughDate ? new Date(throughDate.getTime()) : null;
  if (toDateExclusive) {
    toDateExclusive.setUTCDate(toDateExclusive.getUTCDate() + 1);
  }
  const programId =
    query.program &&
    sourcePayments.some((payment) => payment.programId === query.program)
      ? query.program
      : null;
  const programOptions = Array.from(
    new Map(
      sourcePayments.map(
        (payment) =>
          [
            payment.programId,
            { id: payment.programId, name: payment.programName },
          ] as const,
      ),
    ).values(),
  );
  const currency = displaySettings?.effectiveCurrency ?? "eur";
  const convertTotal = (
    totals: readonly { currency: string; total: string }[],
  ) => convertCurrencyTotals(totals, currency, rates);
  const presentTotal = (converted: ReturnType<typeof convertTotal>) => ({
    value:
      converted.total === null
        ? "—"
        : `${converted.isEstimate ? "≈ " : ""}${formatCurrencyAtMinorUnitPrecision(converted.total, currency)}`,
    hint: converted.unconverted.length
      ? `Not converted: ${converted.unconverted
          .map(
            (row) =>
              `${formatCurrencyAtMinorUnitPrecision(row.total, row.currency)} ${row.currency}`,
          )
          .join(" · ")}`
      : null,
    hasAmount:
      (converted.total !== null && Number(converted.total) !== 0) ||
      converted.unconverted.some((row) => Number(row.total) !== 0),
  });
  const pending = convertTotal(metrics.pending);
  const payable = convertTotal(metrics.payable);
  const paid = convertTotal(metrics.paid);
  const allPayments = sourcePayments.map((payment) => {
    const converted = convertTotal(payment.totals);
    return {
      id: payment.id,
      programId: payment.programId,
      programName: payment.programName,
      isException: payment.isException,
      paidAt: payment.paidAt,
      count: payment.count,
      estimate:
        converted.isEstimate && converted.total !== null
          ? `≈ ${formatCurrencyAtMinorUnitPrecision(converted.total, currency)}`
          : null,
      sourceAmounts: payment.totals.map(
        (row) =>
          `${formatCurrencyAtMinorUnitPrecision(row.total, row.currency)} ${row.currency}`,
      ),
      unconverted: converted.unconverted.map(
        (row) =>
          `${formatCurrencyAtMinorUnitPrecision(row.total, row.currency)} ${row.currency}`,
      ),
      isEstimate: converted.isEstimate,
      unconvertedCurrencies: converted.unconverted.map((row) => row.currency),
    };
  });
  const payments = invalidDateRange
    ? []
    : allPayments.filter((payment) => {
        const paidAt = payment.paidAt.getTime();
        return (
          (!fromDate || paidAt >= fromDate.getTime()) &&
          (!toDateExclusive || paidAt < toDateExclusive.getTime()) &&
          (!programId || payment.programId === programId)
        );
      });
  const totals = [pending, payable, paid];
  const estimated =
    totals.some((total) => total.isEstimate) ||
    payments.some((payment) => payment.isEstimate);
  const missingRates = [
    ...new Set([
      ...totals.flatMap((total) =>
        total.unconverted.map((row) => row.currency),
      ),
      ...payments.flatMap((payment) => payment.unconvertedCurrencies),
    ]),
  ].sort();
  const rateNote = [
    `Dashboard currency: ${currency.toUpperCase()}`,
    estimated && rates.rateDate
      ? formatReferenceRateLabel(rates.rateDate)
      : null,
    missingRates.length
      ? `No ECB rate for ${missingRates.join(", ")}; those amounts stay in source currency.`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PayoutsScreen
      key={`${fromDate ? query.dateFrom : ""}:${throughDate ? query.dateTo : ""}:${programId ?? ""}`}
      merchantName={merchant.name}
      payoutDetailsMissing={!payoutDetails?.trim()}
      payments={payments}
      invalidDateRange={invalidDateRange}
      hasPaymentHistory={sourcePayments.length > 0}
      programOptions={programOptions}
      filters={{
        dateFrom: fromDate ? (query.dateFrom ?? "") : "",
        dateTo: throughDate ? (query.dateTo ?? "") : "",
        program: programId ?? "",
      }}
      pending={presentTotal(pending)}
      payable={presentTotal(payable)}
      paid={presentTotal(paid)}
      rateNote={rateNote}
    />
  );
}
