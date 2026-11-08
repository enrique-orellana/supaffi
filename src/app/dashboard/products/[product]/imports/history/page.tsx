import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getMerchantForOwnerBySlug } from "@/lib/merchant";
import { Page, PageTitle, Section } from "@/components/dashboard/Page";

function savedReportSummary(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "No apply report";
  const report = (value as { applyReport?: unknown }).applyReport;
  if (!report || typeof report !== "object" || Array.isArray(report))
    return "No apply report";
  const row = report as {
    merged?: number;
    skipped?: number;
    conflicts?: number;
    unallocated?: number;
    totalsByCurrency?: {
      currency?: string;
      commissionMinor?: string;
      payoutMinor?: string;
    }[];
  };
  const totals = (row.totalsByCurrency ?? [])
    .map(
      (total) =>
        `${total.currency}: c${total.commissionMinor ?? "0"}/p${total.payoutMinor ?? "0"}`,
    )
    .join(", ");
  return `merged ${row.merged ?? 0} · skipped ${row.skipped ?? 0} · conflicts ${row.conflicts ?? 0} · unallocated ${row.unallocated ?? 0}${totals ? ` · ${totals} minor` : ""}`;
}

export default async function AffiliateImportHistoryPage({
  params,
}: {
  params: Promise<{ product: string }>;
}) {
  const { product } = await params;
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  const ownerId = session.user.id;
  if (!(await getMerchantForOwnerBySlug(ownerId, product))) notFound();

  const [batches, commissions, payouts] = await Promise.all([
    db.affiliateImportBatch.findMany({
      where: { ownerId },
      select: {
        id: true,
        sourceAdapter: true,
        sourceFormatVersion: true,
        normalizedDigest: true,
        status: true,
        createdAt: true,
        completedAt: true,
        previewTotals: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.importedCommission.findMany({
      where: { ownerId },
      select: {
        id: true,
        sourceIdentity: true,
        sourceTransactionRef: true,
        currency: true,
        amount: true,
        amountMinor: true,
        refundedAmount: true,
        refundedMinor: true,
        originalStatus: true,
        allocationStatus: true,
        sourceCreatedAt: true,
        importedAt: true,
        merchant: { select: { name: true } },
        targetProgram: { select: { name: true } },
        batch: { select: { sourceAdapter: true } },
      },
      orderBy: { importedAt: "desc" },
      take: 100,
    }),
    db.importedPayout.findMany({
      where: { ownerId },
      select: {
        id: true,
        sourceIdentity: true,
        sourceTransactionRef: true,
        currency: true,
        amount: true,
        amountMinor: true,
        originalStatus: true,
        allocationStatus: true,
        periodStart: true,
        periodEnd: true,
        paidAt: true,
        importedAt: true,
        merchant: { select: { name: true } },
        targetProgram: { select: { name: true } },
        batch: { select: { sourceAdapter: true } },
      },
      orderBy: { importedAt: "desc" },
      take: 100,
    }),
  ]);

  return (
    <Page>
      <PageTitle
        title="Import history"
        subtitle="Read-only source history. These records do not change current commission balances or payout totals."
        actions={
          <Link
            className="rounded-md border border-border px-3 py-2 text-sm"
            href={`/dashboard/products/${product}/imports`}
          >
            Back to imports
          </Link>
        }
      />
      <Section title="Batches" scroll>
        {batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No import batches yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Adapter</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Digest</th>
                  <th className="py-2 pr-4">Apply report</th>
                  <th className="py-2 pr-4">Download</th>
                  <th className="py-2">Completed</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id} className="border-b border-border/60">
                    <td className="py-2 pr-4">
                      {batch.createdAt.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">
                      {batch.sourceAdapter} · v{batch.sourceFormatVersion}
                    </td>
                    <td className="py-2 pr-4">{batch.status}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {batch.normalizedDigest.slice(0, 16)}…
                    </td>
                    <td className="max-w-sm py-2 pr-4 text-xs">
                      {savedReportSummary(batch.previewTotals)}
                    </td>
                    <td className="py-2 pr-4">
                      {batch.status === "COMPLETED" ? (
                        <Link
                          className="underline"
                          href={`/dashboard/products/${product}/imports/${batch.id}/report`}
                        >
                          CSV
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2">
                      {batch.completedAt?.toLocaleString() ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Commission records" scroll>
        {commissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No commission records imported.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Refunded</th>
                  <th className="py-2 pr-4">Source status</th>
                  <th className="py-2">Imported</th>
                </tr>
              </thead>
              <tbody>
                {commissions.map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-2 pr-4">
                      <div>
                        {row.sourceIdentity.split(":commission:").at(-1)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {row.sourceTransactionRef ?? row.batch.sourceAdapter}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      {row.merchant?.name && row.targetProgram?.name
                        ? `${row.merchant.name} · ${row.targetProgram.name}`
                        : "Unallocated"}
                    </td>
                    <td className="py-2 pr-4">
                      {row.amount.toFixed(6)} {row.currency}
                      {row.amountMinor !== null ? (
                        <div className="text-xs text-muted-foreground">
                          {row.amountMinor.toString()} minor
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">
                      {row.refundedAmount?.toFixed(6) ?? "—"} {row.currency}
                      {row.refundedMinor !== null ? (
                        <div className="text-xs text-muted-foreground">
                          {row.refundedMinor.toString()} minor
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">
                      {row.originalStatus} · {row.allocationStatus}
                    </td>
                    <td className="py-2">
                      {row.importedAt.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Payout snapshots" scroll>
        {payouts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No payout snapshots imported.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Period</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-2 pr-4">
                      <div>{row.sourceIdentity.split(":payout:").at(-1)}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.sourceTransactionRef ?? row.batch.sourceAdapter}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      {row.merchant?.name && row.targetProgram?.name
                        ? `${row.merchant.name} · ${row.targetProgram.name}`
                        : "Unallocated"}
                    </td>
                    <td className="py-2 pr-4">
                      {row.amount.toFixed(6)} {row.currency}
                      {row.amountMinor !== null ? (
                        <div className="text-xs text-muted-foreground">
                          {row.amountMinor.toString()} minor
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">
                      {row.periodStart?.toLocaleDateString() ?? "—"} –{" "}
                      {row.periodEnd?.toLocaleDateString() ?? "—"}
                    </td>
                    <td className="py-2">
                      {row.originalStatus} · {row.allocationStatus}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Page>
  );
}
