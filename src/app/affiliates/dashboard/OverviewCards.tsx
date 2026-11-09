import Link from "next/link";
import type { AffiliateCommissionRow } from "@/lib/affiliate";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import { cn } from "@/lib/utils";
import { change, rangeLabel } from "@/lib/analyticsShared";
import type { Bucket, ChartRange, DayPoint } from "@/lib/analytics";
import { formatCount } from "@/lib/format";
import { Page, PageTitle, Tiles, Section } from "@/components/dashboard/Page";
import { StatTile } from "@/components/dashboard/StatTile";
import { ActivityChart } from "@/components/charts/ActivityChart";
import { RangePicker } from "@/components/charts/RangePicker";
import { CopyField } from "@/components/onboarding/CodeBlock";
import { Badge } from "@/components/ui/badge";
import {
  STATUS_LABELS,
  STATUS_STYLES,
  toLedgerRow,
} from "./commissions/CommissionLedger";

/**
 * The affiliate's own dashboard: the link they came for, what they have
 * earned, and what is on its way.
 *
 * Presentational on purpose. The page reads the database and hands the whole
 * screen over as props, so it can be read in the dev kit with fixtures.
 *
 * Four figures, no more. Clicks and sales are the chart's job, and a fifth
 * tile computed from the first four ("rate") is arithmetic on screen rather
 * than something to act on.
 */

export type OverviewView = {
  /** The signup link, already built into a shareable URL. */
  referralUrl: string | null;
  /** What they earn under, as one line. See `termsLine`. */
  terms: string;
  recent: (AffiliateCommissionRow & {
    convertedAmount: string | null;
    conversionUnavailable: boolean;
  })[];
  series: DayPoint[];
  unconvertedByBucket: Record<string, readonly string[]>;
  chartIsEstimate: boolean;
  bucket: Bucket;
  /** The affiliate's Settings choice or current Program default. */
  currency: string;
  currentClicks: number;
  previousClicks: number | null;
  currentEarned: number;
  currentEarnedDisplay: MoneyDisplay;
  previousEarned: number | null;
  range: ChartRange;
  rateNote: string | null;
  earned: MoneyDisplay;
  pending: MoneyDisplay;
  payable: MoneyDisplay;
  paid: MoneyDisplay;
  /** Counts only. Which customers they are is never the affiliate's to see. */
  referrals: { total: number; active: number };
  /**
   * Whether the program pays beyond the first payment and the affiliate has
   * referred someone. Otherwise there is no "still paying" question to
   * answer, so the card is not shown at all.
   */
  recurring: boolean;
};

export type MoneyDisplay = {
  value: string;
  hint: string | null;
  hasAmount: boolean;
};

/**
 * How many of the customers this affiliate brought in are still paying.
 *
 * A recurring program lives or dies on this number, and it is the one thing
 * the ledger cannot show: a commission that stopped arriving looks exactly
 * like a quiet month.
 */
function Referrals({ total, active }: { total: number; active: number }) {
  const share = total === 0 ? 0 : active / total;

  return (
    <div className="flex flex-1 flex-col justify-center gap-3">
      <div className="flex flex-col gap-1">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[32px] leading-none font-medium tracking-tight tabular-nums">
            {active}
          </span>
          {total > 0 && (
            <span className="text-[15px] text-muted-foreground tabular-nums">
              of {total}
            </span>
          )}
        </span>
        <span className="text-[13px] text-muted-foreground">still paying</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-(--radius) bg-muted">
        {share > 0 && (
          <div
            className="h-full rounded-(--radius) bg-accent-500"
            style={{ width: `${Math.max(4, Math.round(share * 100))}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function OverviewScreen({
  referralUrl,
  terms,
  recent,
  series,
  unconvertedByBucket,
  chartIsEstimate,
  bucket,
  currency,
  currentClicks,
  previousClicks,
  currentEarned,
  currentEarnedDisplay,
  previousEarned,
  range,
  rateNote,
  earned,
  pending,
  payable,
  paid,
  referrals,
  recurring,
}: OverviewView) {
  // Through the ledger's own mapping, so a date and an amount read the same on
  // this card as they do on the ledger the card links to.
  const recentRows = recent.map(toLedgerRow);
  const against =
    range === "all"
      ? ""
      : rangeLabel(range)
          .toLowerCase()
          .replace(/^last /, "previous ")
          .replace(/^this /, "previous ")
          .replace(/^today$/, "yesterday")
          .replace(/^yesterday$/, "the day before");
  const delta = (now: number, before: number | null | undefined) =>
    range === "all"
      ? undefined
      : { percent: change(now, before ?? 0), against };
  return (
    <Page>
      <PageTitle
        title="Overview"
        subtitle={rateNote ?? undefined}
        actions={<RangePicker value={range} />}
      />

      {/* The thing they came for, at the top and on the copy treatment every
          value in the product is copied from. Not a row in a table. */}
      {referralUrl && (
        <div className="flex shrink-0 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[13px] font-medium text-neutral-700">
              Your link
            </span>
            <span className="text-[13px] text-muted-foreground tabular-nums">
              {terms}
            </span>
          </div>
          <CopyField value={referralUrl} />
        </div>
      )}

      {/* Two of these follow the window and two are balances. The balances
          say so in their footnote, so a row that mixes "this month" with
          "right now" never has to be guessed at. */}
      <Tiles>
        <StatTile
          label="Clicks"
          value={formatCount(currentClicks)}
          series={series.map((d) => d.clicks)}
          delta={delta(currentClicks, previousClicks)}
        />
        <StatTile
          label="Earned"
          value={currentEarnedDisplay.value}
          hint={currentEarnedDisplay.hint ?? undefined}
          series={series.map((d) => d.amounts[currency]?.gross ?? 0)}
          delta={delta(currentEarned, previousEarned)}
        />
        <StatTile
          label="Payable"
          value={payable.value}
          hint={[
            payable.hint,
            pending.hasAmount ? "Still on hold" : "Nothing on hold",
            pending.hint,
          ]
            .filter(Boolean)
            .join(" · ")}
          tone={payable.hasAmount ? "accent" : "neutral"}
          href="/affiliates/dashboard/payouts"
        />
        {/* Green is the ledger's colour for money already paid, and it says the
            same thing here. */}
        <StatTile
          label="Paid out"
          value={paid.value}
          hint={[paid.hint, `${earned.value} earned in total`, earned.hint]
            .filter(Boolean)
            .join(" · ")}
          tone={paid.hasAmount ? "success" : "neutral"}
          href="/affiliates/dashboard/payouts"
        />
      </Tiles>

      {/* One band, the shape the owner's own overview uses: the wide chart, and
          a rail of what it turned into. */}
      <div className="grid grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[2fr_1fr]">
        {/* A chart draws into the height it is given, and on a phone the band
            is a stacked column with no height to give, so it gets a floor. */}
        <Section
          title="Clicks and earnings"
          className="min-h-[300px] lg:min-h-0"
          fill
        >
          {/* No empty branch: the series is zero filled, so a brand new
              affiliate gets a flat line rather than an empty box. */}
          <ActivityChart
            points={series}
            bucket={bucket}
            currency={currency}
            barLabel={chartIsEstimate ? "Estimated earned" : "Earned"}
            countLabel="Commissions"
            unconverted={unconvertedByBucket}
          />
        </Section>

        <div
          className={cn(
            "grid gap-4 lg:min-h-0",
            recurring ? "lg:grid-rows-[auto_1fr]" : "lg:grid-rows-1",
          )}
        >
          {recurring && (
            <Section title="Referrals">
              <Referrals total={referrals.total} active={referrals.active} />
            </Section>
          )}

          <Section
            scroll
            title="Recent commissions"
            actions={
              <Link
                href="/affiliates/dashboard/commissions"
                className="cursor-pointer text-[13px] text-muted-foreground hover:text-foreground"
              >
                All
              </Link>
            }
          >
            {recentRows.length === 0 ? (
              <p className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
                Nothing yet
              </p>
            ) : (
              <ul className="flex flex-col">
                {recentRows.map((row) => (
                  // Date, then state, then the figure hard against the right
                  // edge: the amounts line up as a column, which is the only
                  // arrangement of the three that lets them be compared.
                  <li
                    key={row.id}
                    className="flex items-center gap-2.5 border-b border-neutral-200 py-2.5 last:border-0"
                  >
                    {/* The badge is what gives way when the row runs out of
                        room: a date and an amount are facts and are never cut,
                        so below sm the badge drops to a line of its own rather
                        than squeezing the two figures beside it. */}
                    <div className="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2.5">
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {row.dateLabel}
                      </span>
                      <Badge
                        className={cn("max-w-full", STATUS_STYLES[row.status])}
                      >
                        {STATUS_LABELS[row.status]}
                      </Badge>
                    </div>
                    <span
                      className={cn(
                        "flex flex-col",
                        "ml-auto shrink-0 text-right text-[13px] font-medium tabular-nums",
                        row.isAdjustment
                          ? "text-destructive"
                          : "text-neutral-900",
                        row.status === COMMISSION_STATUS.VOIDED &&
                          "font-normal text-muted-foreground",
                      )}
                    >
                      {row.amount}
                      {row.convertedAmount && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {row.convertedAmount}
                        </span>
                      )}
                      {row.conversionUnavailable && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          Not converted
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </Page>
  );
}
