import { Button } from "@/components/ui/button";
import { Page, PageTitle, Tiles, Section } from "@/components/dashboard/Page";
import { StatTile } from "@/components/dashboard/StatTile";
import type { CheckResult } from "@/lib/checks/dns";
import { siteHost } from "@/lib/onboarding";
import type { DayPoint } from "@/lib/analytics";
import { formatDate } from "@/lib/format";
import { CodeBlock } from "@/components/onboarding/CodeBlock";
import { ProviderTrackingInstructions } from "@/components/payments/ProviderTrackingInstructions";
import type { PaymentProviderTrackingGuide } from "@/lib/payments/setupRegistry";

/**
 * Tracking, as a status page: is the script on the site, is anything arriving,
 * and the two snippets to copy again if it is not.
 *
 * The light comes from the shared check cache, which the page refreshes on
 * demand. An owner who has just pasted the tag wants to know whether it took,
 * and clicks only prove it after somebody visits.
 */

export function TrackingStatus({
  merchant,
  script,
  clicks,
  series,
  lastClickAt,
  clickedRecently,
  verifiedAt,
  scriptTag,
  trackingGuides,
  scriptPrompt,
  checkAgain,
}: {
  merchant: { domain: string; websiteUrl: string };
  script: CheckResult;
  clicks: number;
  series: DayPoint[];
  lastClickAt: Date | null;
  /**
   * A click arrived this week. Clicks only come through the script, so this
   * proves it is on the site even when the homepage fetch misses it (a script
   * on landing pages only, or a site that blocks the fetch).
   */
  clickedRecently: boolean;
  verifiedAt: Date | null;
  scriptTag: string;
  trackingGuides: readonly PaymentProviderTrackingGuide[];
  /** The plain text an owner forwards to whoever touches the code. */
  scriptPrompt: string;
  checkAgain: () => Promise<void>;
}) {
  const live = script.ok || clickedRecently;
  return (
    <Page>
      <PageTitle
        title="Tracking"
        subtitle={merchant.domain}
        actions={
          <form action={checkAgain}>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="cursor-pointer"
            >
              Check the site again
            </Button>
          </form>
        }
      />

      <Tiles>
        <StatTile
          label="Script"
          value={live ? "Live" : "Not found"}
          hint={
            live
              ? `on ${siteHost(merchant.websiteUrl)}`
              : `Looking on ${siteHost(merchant.websiteUrl)}`
          }
          tone={live ? "success" : "warning"}
        />
        <StatTile
          label="Clicks, 30 days"
          value={String(clicks)}
          series={series.map((d) => d.clicks)}
        />
        <StatTile
          label="Last click"
          value={lastClickAt ? formatDate(lastClickAt) : "None yet"}
        />
        <StatTile
          label="First sale"
          value={verifiedAt ? formatDate(verifiedAt) : "Not yet"}
        />
      </Tiles>

      <Section title="Script tag">
        <p className="mb-2 text-[13px] text-muted-foreground">
          In the head of every page an affiliate link can land on.
        </p>
        <CodeBlock
          title="Tracking script"
          code={scriptTag}
          prompt={scriptPrompt}
        />
      </Section>

      <Section title="Checkout">
        <p className="mb-2 text-[13px] text-muted-foreground">
          Requirements for your connected payment providers.
        </p>
        <ProviderTrackingInstructions guides={trackingGuides} />
      </Section>

    </Page>
  );
}
