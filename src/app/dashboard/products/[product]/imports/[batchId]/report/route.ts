import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getMerchantForOwnerBySlug } from "@/lib/merchant";

export const dynamic = "force-dynamic";

function csvCell(value: string | null): string {
  let safe = value ?? "";
  if (/^[=+\-@]/.test(safe)) safe = "'" + safe;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvRow(values: (string | null)[]): string {
  return values.map(csvCell).join(",") + "\r\n";
}

export async function GET(_request: Request, context: { params: Promise<{ product: string; batchId: string }> }) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") return new Response(null, { status: 401 });
  const ownerId = session.user.id;
  const { product, batchId } = await context.params;
  if (!await getMerchantForOwnerBySlug(ownerId, product)) return new Response(null, { status: 404 });
  const batch = await db.affiliateImportBatch.findFirst({
    where: { id: batchId, ownerId, status: "COMPLETED" },
    select: { id: true },
  });
  if (!batch) return new Response(null, { status: 404 });

  const encoder = new TextEncoder();
  let cursor: string | undefined;
  let ended = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvRow(["source_kind", "source_id", "outcome", "target_merchant_id", "reason", "currency", "amount_minor"])));
    },
    async pull(controller) {
      if (ended) return;
      try {
        const rows = await db.affiliateImportRowResult.findMany({
          where: { batchId: batch.id, ownerId },
          select: { id: true, sourceKind: true, sourceId: true, outcome: true, targetMerchantId: true, reason: true, currency: true, amountMinor: true },
          orderBy: { id: "asc" },
          take: 1000,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (!rows.length) {
          ended = true;
          controller.close();
          return;
        }
        cursor = rows[rows.length - 1]!.id;
        controller.enqueue(encoder.encode(rows.map((row) => csvRow([
          row.sourceKind,
          row.sourceId,
          row.outcome,
          row.targetMerchantId,
          row.reason,
          row.currency,
          row.amountMinor?.toString() ?? null,
        ])).join("")));
      } catch (error) {
        ended = true;
        controller.error(error);
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="affiliate-import-${batch.id}-report.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
