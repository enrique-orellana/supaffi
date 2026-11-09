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

/**
 * What being paid looks like when Supaffi never touches the money: the
 * totals that answer "how much, and when", the payout details the merchant
 * pays against, and a history that is derived rather than a ledger of
 * transfers, because no transfer runs through this product.
 */
export default async function AffiliatePayoutsPage() {
  const { affiliateId, merchant } = await requireAffiliate();

  const [metrics, payoutDetails, sourcePayments, displaySettings, rates] =
    await Promise.all([
      getAffiliateMetrics(affiliateId),
      getAffiliatePayoutDetails(affiliateId),
      listAffiliatePayments(affiliateId),
      getAffiliateDisplaySettings(affiliateId, merchant.id),
      getEcbReferenceRates(),
    ]);
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
  const payments = sourcePayments.map((payment) => {
    const converted = convertTotal(payment.totals);
    return {
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
      merchantName={merchant.name}
      payoutDetails={payoutDetails}
      payments={payments}
      pending={presentTotal(pending)}
      payable={presentTotal(payable)}
      paid={presentTotal(paid)}
      rateNote={rateNote}
    />
  );
}
