import { requireAffiliate } from "@/lib/affiliateAuth";
import { getAffiliateDisplaySettings } from "@/lib/affiliateDisplaySettings";
import {
  convertCurrencyTotals,
  formatCurrencyAtMinorUnitPrecision,
  formatReferenceRateLabel,
  getEcbReferenceRates,
} from "@/lib/currency";
import { listLinksWithStats } from "@/lib/affiliateLink";
import { LinksScreen } from "./LinksScreen";

export default async function AffiliateLinksPage() {
  const { affiliateId, merchant } = await requireAffiliate();
  const [sourceLinks, displaySettings, rates] = await Promise.all([
    listLinksWithStats(affiliateId),
    getAffiliateDisplaySettings(affiliateId, merchant.id),
    getEcbReferenceRates(),
  ]);
  const currency = displaySettings?.effectiveCurrency ?? "eur";
  const links = sourceLinks.map((link) => {
    const converted = convertCurrencyTotals(link.earned, currency, rates);
    return {
      ...link,
      displayEarnings:
        converted.total === null
          ? "—"
          : `${converted.isEstimate ? "≈ " : ""}${formatCurrencyAtMinorUnitPrecision(converted.total, currency)}`,
      unconvertedEarnings: converted.unconverted.map(
        (row) =>
          `${formatCurrencyAtMinorUnitPrecision(row.total, row.currency)} ${row.currency}`,
      ),
      unconvertedCurrencies: converted.unconverted.map((row) => row.currency),
      earningsAreEstimate: converted.isEstimate,
    };
  });
  const estimated = links.some((link) => link.earningsAreEstimate);
  const missingRates = [
    ...new Set(links.flatMap((link) => link.unconvertedCurrencies)),
  ].sort();
  const rateNote = [
    `Dashboard currency: ${currency.toUpperCase()}`,
    estimated && rates.rateDate
      ? formatReferenceRateLabel(rates.rateDate)
      : null,
    missingRates.length
      ? `No ECB rate for ${missingRates.join(", ")}; those earnings stay in source currency.`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <LinksScreen
      links={links}
      websiteUrl={merchant.websiteUrl}
      rateNote={rateNote}
    />
  );
}
