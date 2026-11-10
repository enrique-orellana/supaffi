import { db } from "@/lib/db";
import { requireAffiliate } from "@/lib/affiliateAuth";
import { resolveCurrentCommissionTerms } from "@/lib/commissionTerms";
import { getAffiliateDisplaySettings } from "@/lib/affiliateDisplaySettings";
import {
  convertCurrencyChart,
  convertCurrencyTotals,
  formatCurrencyAtMinorUnitPrecision,
  formatReferenceRateLabel,
  getEcbReferenceRates,
} from "@/lib/currency";
import { getAffiliateMetrics, rangeFromQuery } from "@/lib/analytics";
import { listAffiliateCommissions, referralCounts } from "@/lib/affiliate";
import { listLinksWithStats, linkUrl } from "@/lib/affiliateLink";
import { termsLine } from "@/lib/format";
import { OverviewScreen } from "./OverviewCards";

/**
 * A layout only. Everything the screen shows is rendered by `OverviewScreen`,
 * which takes it all as props.
 */

/** Enough rows to fill the card at any height the band can take. */
const RECENT_COMMISSIONS = 6;

function periodTotals(
  amounts: Record<
    string,
    { gross: number; commission: number; sales: number }
  > | null,
  field: "gross" | "commission",
) {
  return Object.entries(amounts ?? {}).map(([currency, values]) => ({
    currency,
    total: String(values[field]),
  }));
}

function moneyDisplay(
  total: ReturnType<typeof convertCurrencyTotals>,
  hasAmount: boolean,
) {
  const value =
    total.total === null
      ? "—"
      : `${total.isEstimate ? "≈ " : ""}${formatCurrencyAtMinorUnitPrecision(total.total, total.targetCurrency)}`;
  const unconverted = total.unconverted.map(
    (row) =>
      `${formatCurrencyAtMinorUnitPrecision(row.total, row.currency)} ${row.currency}`,
  );
  return {
    value,
    hint: unconverted.length
      ? `Not converted: ${unconverted.join(" · ")}`
      : null,
    hasAmount,
  };
}

export default async function AffiliateOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { affiliateId, merchant } = await requireAffiliate();
  const query = await searchParams;
  const range = rangeFromQuery(query.range);

  const [
    metrics,
    links,
    commissions,
    referrals,
    program,
    displaySettings,
    rates,
  ] = await Promise.all([
    getAffiliateMetrics(affiliateId, range),
    listLinksWithStats(affiliateId),
    listAffiliateCommissions(affiliateId, {
      page: 1,
      pageSize: RECENT_COMMISSIONS,
    }),
    referralCounts(affiliateId),
    // The terms line, and the retention card: on a one-time program nobody
    // is "still paying", so that card is not shown.
    db.affiliate.findUnique({
      where: { id: affiliateId },
      select: {
        programId: true,
        customCommissionRate: true,
        commissionDurationTypeOverride: true,
        commissionDurationMonthsOverride: true,
        attributionWindowDaysOverride: true,
        holdingPeriodDaysOverride: true,
        minimumPayoutAmountOverride: true,
        program: {
          select: {
            id: true,
            defaultCommissionRate: true,
            commissionDurationType: true,
            commissionDurationMonths: true,
            attributionWindowDays: true,
            holdingPeriodDays: true,
            minimumPayoutAmount: true,
          },
        },
      },
    }),
    getAffiliateDisplaySettings(affiliateId, merchant.id),
    getEcbReferenceRates(),
  ]);

  const currency = displaySettings?.effectiveCurrency ?? "eur";
  const convertTotal = (
    totals: readonly { currency: string; total: string }[],
  ) => convertCurrencyTotals(totals, currency, rates);
  const earnedTotal = convertTotal([...metrics.unpaid, ...metrics.paid]);
  const pendingTotal = convertTotal(metrics.pending);
  const payableTotal = convertTotal(metrics.payable);
  const paidTotal = convertTotal(metrics.paid);
  const currentEarnedTotal = convertTotal(
    periodTotals(metrics.current.amounts, "gross"),
  );
  const previousEarnedTotal = metrics.previous
    ? convertTotal(periodTotals(metrics.previous.amounts, "gross"))
    : null;
  const chart = convertCurrencyChart(metrics.series, currency, rates);
  const series = metrics.series.map((point, index) => {
    const converted = chart[index];
    return {
      ...point,
      amounts: {
        [currency]: {
          gross: Number(converted?.gross ?? 0),
          commission: Number(converted?.commission ?? 0),
          sales: converted?.sales ?? 0,
        },
      },
    };
  });
  const unconvertedByBucket = Object.fromEntries(
    chart
      .filter((point) => point.unconverted.length > 0)
      .map((point) => [
        point.date,
        point.unconverted.map(
          (row) =>
            `${formatCurrencyAtMinorUnitPrecision(row.gross, row.currency)} ${row.currency}`,
        ),
      ]),
  );
  const chartIsEstimate = chart.some((point) => point.isEstimate);

  const recent = commissions.rows.map((row) => {
    const converted = convertTotal([
      { currency: row.currency, total: row.amount },
    ]);
    return {
      ...row,
      convertedAmount:
        converted.isEstimate && converted.total !== null
          ? `≈ ${formatCurrencyAtMinorUnitPrecision(converted.total, currency)}`
          : null,
      conversionUnavailable: converted.total === null,
    };
  });

  const rateDate = rates.rateDate;
  const hasEstimate =
    earnedTotal.isEstimate ||
    pendingTotal.isEstimate ||
    payableTotal.isEstimate ||
    paidTotal.isEstimate ||
    currentEarnedTotal.isEstimate ||
    Boolean(previousEarnedTotal?.isEstimate) ||
    chartIsEstimate ||
    recent.some((row) => row.convertedAmount !== null);
  const unconvertedCurrencies = new Set([
    ...earnedTotal.unconverted.map((row) => row.currency),
    ...pendingTotal.unconverted.map((row) => row.currency),
    ...payableTotal.unconverted.map((row) => row.currency),
    ...paidTotal.unconverted.map((row) => row.currency),
    ...currentEarnedTotal.unconverted.map((row) => row.currency),
    ...(previousEarnedTotal?.unconverted.map((row) => row.currency) ?? []),
    ...chart.flatMap((point) => point.unconverted.map((row) => row.currency)),
    ...recent
      .filter((row) => row.conversionUnavailable)
      .map((row) => row.currency),
  ]);
  const rateNote = [
    `Dashboard currency: ${currency.toUpperCase()}`,
    hasEstimate && rateDate ? formatReferenceRateLabel(rateDate) : null,
    unconvertedCurrencies.size > 0
      ? `No ECB rate for ${[...unconvertedCurrencies].sort().join(", ")}; those amounts stay in source currency.`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // The signup link: the one the merchant's own dashboard shows and the one in
  // every email they have had from this program.
  const primary = links.find((link) => link.isPrimary) ?? links[0] ?? null;
  const currentTerms = program
    ? resolveCurrentCommissionTerms(program.program, program)
    : null;

  return (
    <OverviewScreen
      referralUrl={primary ? linkUrl(merchant.websiteUrl, primary) : null}
      terms={
        currentTerms
          ? termsLine({
              rate: currentTerms.commissionRate.toNumber(),
              durationType:
                currentTerms.commissionDuration.commissionDurationType,
              durationMonths:
                currentTerms.commissionDuration.commissionDurationMonths,
              attributionWindowDays: currentTerms.attributionWindowDays,
              holdingPeriodDays: currentTerms.holdingPeriodDays,
              minimumPayoutAmount: currentTerms.minimumPayoutAmount.toFixed(2),
            })
          : ""
      }
      recent={recent}
      series={series}
      unconvertedByBucket={unconvertedByBucket}
      chartIsEstimate={chartIsEstimate}
      bucket={metrics.bucket}
      currency={currency}
      currentClicks={metrics.current.clicks}
      previousClicks={metrics.previous?.clicks ?? null}
      currentEarned={Number(currentEarnedTotal.total ?? 0)}
      previousEarned={
        previousEarnedTotal?.total === null || previousEarnedTotal === null
          ? null
          : Number(previousEarnedTotal.total)
      }
      range={range}
      rateNote={rateNote}
      currentEarnedDisplay={moneyDisplay(
        currentEarnedTotal,
        (currentEarnedTotal.total !== null &&
          Number(currentEarnedTotal.total) !== 0) ||
          currentEarnedTotal.unconverted.some((row) => Number(row.total) !== 0),
      )}
      earned={moneyDisplay(
        earnedTotal,
        (earnedTotal.total !== null && Number(earnedTotal.total) !== 0) ||
          earnedTotal.unconverted.some((row) => Number(row.total) !== 0),
      )}
      pending={moneyDisplay(
        pendingTotal,
        (pendingTotal.total !== null && Number(pendingTotal.total) !== 0) ||
          pendingTotal.unconverted.some((row) => Number(row.total) !== 0),
      )}
      payable={moneyDisplay(
        payableTotal,
        (payableTotal.total !== null && Number(payableTotal.total) !== 0) ||
          payableTotal.unconverted.some((row) => Number(row.total) !== 0),
      )}
      paid={moneyDisplay(
        paidTotal,
        (paidTotal.total !== null && Number(paidTotal.total) !== 0) ||
          paidTotal.unconverted.some((row) => Number(row.total) !== 0),
      )}
      referrals={referrals}
      recurring={
        program?.program.commissionDurationType !== "ONE_TIME" &&
        referrals.total > 0
      }
    />
  );
}
