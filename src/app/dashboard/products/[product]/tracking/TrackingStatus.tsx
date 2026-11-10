import { Button } from "@/components/ui/button";
import { Page, PageTitle, Tiles, Section } from "@/components/dashboard/Page";
import { StatTile } from "@/components/dashboard/StatTile";
import type { CheckResult } from "@/lib/checks/dns";
import { siteHost } from "@/lib/onboarding";
import type { DayPoint } from "@/lib/analytics";
import { formatDate, formatMoney } from "@/lib/format";
import { CodeBlock } from "@/components/onboarding/CodeBlock";
import { ProviderTrackingInstructions } from "@/components/payments/ProviderTrackingInstructions";
import type { PaymentProviderTrackingGuide } from "@/lib/payments/setupRegistry";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type UnattributedPayment = {
  id: string;
  recordedAt: Date;
  amount: string;
  currency: string;
  paymentId: string | null;
  invoiceId: string | null;
};

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
  unattributedPayments,
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
  /** Recent completed NOWPayments sales that have no affiliate click attached. */
  unattributedPayments: readonly UnattributedPayment[];
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

      {unattributedPayments.length > 0 && (
        <Section title="Completed payments without an affiliate referral" flush>
          <p className="px-5 pb-4 text-[13px] text-muted-foreground">
            These NOWPayments sales completed, but no affiliate referral is
            attached. Direct sales may be expected. If an affiliate link was
            used, compare the invoice ID with the checkout record. No commission
            was created for these payments.
          </p>
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow>
                <TableHead>Recorded</TableHead>
                <TableHead className="text-right">Sale</TableHead>
                <TableHead>Payment ID</TableHead>
                <TableHead>Invoice ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {unattributedPayments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell className="text-muted-foreground">
                    {formatDate(payment.recordedAt)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatMoney(payment.amount, payment.currency)}
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal break-all font-mono text-xs">
                    {payment.paymentId ?? "Not provided"}
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal break-all font-mono text-xs">
                    {payment.invoiceId ?? "Not provided"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="px-5 py-3 text-xs text-muted-foreground">
            Showing the 25 most recent completed payments without a referral.
          </p>
        </Section>
      )}

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
