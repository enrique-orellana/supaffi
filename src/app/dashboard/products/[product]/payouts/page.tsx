import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { auth } from "@/lib/auth";
import { getMerchantForOwnerBySlug } from "@/lib/merchant";
import { getCommissionFilterOptions } from "@/lib/commission";
import { getOwedTotals, getPayableGroups, listPayouts } from "@/lib/analytics";
import {
  formatCount,
  formatDate,
  formatMoney,
  money,
  moneyHint,
} from "@/lib/format";
import { alreadyPaidNote, refusalText, skippedNote } from "@/lib/payoutNotices";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Page, PageTitle, Section } from "@/components/dashboard/Page";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { CopyValue } from "@/components/CopyValue";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PayoutFilters } from "./PayoutFilters";
import { MarkPayoutDialog } from "./MarkPayoutDialog";

/**
 * The monthly job: who is owed what today, where to send it, and Mark paid.
 * Then every payout already made.
 *
 * One row per affiliate and currency, because that is what a payout is: the
 * ledger refuses a write that spans either. Each row binds the exact
 * commissions and amounts read at render time and the moment the page was
 * drawn, never a re-query at write time, so a commission that clears its hold
 * between paint and click is not swept in.
 */

const HISTORY_PAGE_SIZE = 25;

const HEAD = "h-9 text-[13px] font-medium text-neutral-700";

export default async function PayoutsPage({
  params,
  searchParams,
}: {
  params: Promise<{ product: string }>;
  searchParams: Promise<{
    tab?: string;
    page?: string;
    error?: string;
    skipped?: string;
    already?: string;
    paidOn?: string;
    recorded?: string;
    affiliate?: string;
    currency?: string;
    q?: string;
  }>;
}) {
  const { product } = await params;
  const query = await searchParams;
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  const ownerId = session.user.id;

  const merchant = await getMerchantForOwnerBySlug(ownerId, product);
  if (!merchant) notFound();

  // A page query used to mean the Paid history, before tabs were added.
  const tab =
    query.tab === "paid" || (!query.tab && query.page) ? "paid" : "ready";
  const page =
    tab === "paid" ? Math.max(1, Math.floor(Number(query.page)) || 1) : 1;
  const affiliateFilter = (query.affiliate ?? "").slice(0, 64);
  const currencyFilter = (query.currency ?? "").slice(0, 32);
  const queryFilter = (query.q ?? "").trim().slice(0, 100);
  const filters = {
    affiliateId: affiliateFilter || null,
    currency: currencyFilter || null,
    query: queryFilter || null,
  };
  // Taken before any commission is read. Mark paid compares it with when a
  // refund voided a shown row, so it has to be no later than the read.
  const renderedAt = new Date().toISOString();

  const [groups, history, filterOptions, { payableNow }] = await Promise.all([
    getPayableGroups(ownerId, merchant.id, undefined, filters),
    listPayouts(ownerId, merchant.id, {
      page,
      pageSize: HISTORY_PAGE_SIZE,
      ...filters,
    }),
    getCommissionFilterOptions(ownerId, merchant.id),
    getOwedTotals(ownerId, merchant.id),
  ]);

  const base = `/dashboard/products/${merchant.slug}`;
  const productRef = { id: merchant.id, slug: merchant.slug };
  const noticeParams = new URLSearchParams();
  for (const [key, value] of Object.entries({
    error: query.error,
    skipped: query.skipped,
    already: query.already,
    paidOn: query.paidOn,
    recorded: query.recorded,
  })) {
    if (value) noticeParams.set(key, value);
  }
  const payoutHref = (targetTab: "ready" | "paid", targetPage?: number) => {
    const params = new URLSearchParams(noticeParams);
    if (targetTab === "paid") params.set("tab", targetTab);
    else params.delete("tab");
    if (affiliateFilter) params.set("affiliate", affiliateFilter);
    if (currencyFilter) params.set("currency", currencyFilter);
    if (queryFilter) params.set("q", queryFilter);
    if (targetPage && targetPage > 1) params.set("page", String(targetPage));
    const search = params.toString();
    return `${base}/payouts${search ? `?${search}` : ""}`;
  };
  const pageHref = (p: number) => payoutHref("paid", p);

  const refusal = refusalText(query.error);
  const skipped = skippedNote(query.skipped);
  const alreadyPaid = alreadyPaidNote(
    query.already,
    query.paidOn,
    query.recorded,
  );
  const hint = moneyHint(payableNow);
  const anyFilterActive = Boolean(
    affiliateFilter || currencyFilter || queryFilter,
  );
  const filtersBar = (
    <PayoutFilters
      key={queryFilter}
      affiliates={filterOptions.affiliates}
      currencies={filterOptions.currencies}
      affiliateId={affiliateFilter || null}
      currency={currencyFilter || null}
      query={queryFilter}
      anyFilterActive={anyFilterActive}
    />
  );

  return (
    <Page>
      <PageTitle
        title="Payouts"
        subtitle={
          groups.length > 0
            ? `${money(payableNow)}${hint ? ` and ${hint}` : ""} ready to pay`
            : undefined
        }
        actions={
          <Tabs value={tab} className="shrink-0">
            <TabsList variant="line">
              <TabsTrigger
                value="ready"
                render={
                  <Link href={payoutHref("ready")} className="cursor-pointer" />
                }
              >
                Ready to pay
                <span className="ml-1.5 text-muted-foreground tabular-nums">
                  {groups.length}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="paid"
                render={
                  <Link href={payoutHref("paid")} className="cursor-pointer" />
                }
              >
                Paid
                <span className="ml-1.5 text-muted-foreground tabular-nums">
                  {history.total}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {refusal && (
        <p className="shrink-0 text-[13px] text-status-warning">{refusal}</p>
      )}
      {skipped && (
        <p className="shrink-0 text-[13px] text-muted-foreground">{skipped}</p>
      )}
      {alreadyPaid && (
        <p className="shrink-0 text-[13px] text-status-warning">
          {alreadyPaid}
        </p>
      )}

      {tab === "ready" ? (
        <Section flush scroll className="overflow-hidden">
          {filtersBar}
          {groups.length === 0 ? (
            <EmptyState
              icon={<Wallet />}
              title={
                anyFilterActive
                  ? "Nothing matches these filters"
                  : "Nothing to pay"
              }
            />
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-neutral-100">
                <TableRow className="border-neutral-200 hover:bg-transparent">
                  <TableHead className={HEAD}>Affiliate</TableHead>
                  <TableHead className={HEAD}>Pay to</TableHead>
                  <TableHead className={`${HEAD} text-right`}>
                    Commissions
                  </TableHead>
                  <TableHead className={`${HEAD} text-right`}>Amount</TableHead>
                  <TableHead className={HEAD} />
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-neutral-200">
                {groups.map((group) => (
                  <TableRow
                    key={`${group.affiliateId}:${group.currency}`}
                    className="border-neutral-200 hover:bg-neutral-50"
                  >
                    <TableCell className="max-w-56">
                      <Link
                        href={`${base}/affiliates?affiliate=${group.affiliateId}`}
                        className="block cursor-pointer truncate font-medium hover:underline"
                      >
                        {group.affiliateName ?? group.affiliateEmail}
                      </Link>
                      {group.affiliateName && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {group.affiliateEmail}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-72 text-sm">
                      {group.payoutDetails ? (
                        <CopyValue value={group.payoutDetails} />
                      ) : (
                        <span className="text-status-warning">
                          Not given yet
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatCount(group.commissions.length)}
                    </TableCell>
                    <TableCell className="text-right text-[15px] font-medium whitespace-nowrap tabular-nums">
                      {formatMoney(group.total, group.currency)}
                    </TableCell>
                    <TableCell className="w-px text-right">
                      <MarkPayoutDialog
                        product={productRef}
                        group={group}
                        renderedAt={renderedAt}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      ) : (
        <Section flush scroll className="overflow-hidden">
          {filtersBar}
          {history.total === 0 ? (
            <EmptyState
              icon={<Wallet />}
              title={
                anyFilterActive
                  ? "No payouts match these filters"
                  : "No payouts yet"
              }
            />
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-neutral-100">
                <TableRow className="border-neutral-200 hover:bg-transparent">
                  <TableHead className={HEAD}>Date</TableHead>
                  <TableHead className={HEAD}>Affiliate</TableHead>
                  <TableHead className={HEAD}>Note</TableHead>
                  <TableHead className={`${HEAD} text-right`}>
                    Commissions
                  </TableHead>
                  <TableHead className={`${HEAD} text-right`}>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-neutral-200">
                {history.rows.map((row) => (
                  <TableRow
                    key={`${row.affiliateId}:${row.currency}:${row.paidAt.toISOString()}:${row.note ?? ""}`}
                    className="border-neutral-200 hover:bg-neutral-50"
                  >
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatDate(row.paidAt)}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <span className="block truncate">
                        {row.affiliateName ?? row.affiliateEmail}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
                      {row.note || "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatCount(row.count)}
                    </TableCell>
                    <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                      {formatMoney(row.total, row.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      )}

      {tab === "paid" && (
        <TablePagination
          page={page}
          pageSize={HISTORY_PAGE_SIZE}
          total={history.total}
          hrefFor={pageHref}
        />
      )}
    </Page>
  );
}
