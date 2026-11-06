import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import type { AffiliateProgramImportBundle } from "@/lib/imports/canonical";
import type { AffiliateImportAdapter } from "@/lib/imports/adapters/types";
import { adapterSupportsBundle } from "@/lib/imports/adapters/types";
import { importUploadSizeIssue, validateAffiliateImportBundle, type ImportValidationIssue } from "@/lib/imports/validate";

export type AffiliateImportMappingChoices = {
  affiliateTargets?: Record<string, string>;
  productTargets?: Record<string, string>;
};

export type ImportPreviewContext = {
  affiliates: readonly { id: string; merchantId: string; email: string | null; commissionRateBps: number | null }[];
  referralCodes: readonly { merchantId: string; code: string }[];
  products: readonly { id: string; merchantId: string; trustworthy: boolean }[];
};

export type CurrencyTotals = { currency: string; grossMinor: string; refundedMinor: string; netMinor: string };
export type PayoutCurrencyTotals = { currency: string; totalMinor: string };
export type PreviewConflict = { sourceId: string; targetId?: string; reason: string };

export type AffiliateImportPreview = {
  batchId: string;
  digest: string;
  counts: {
    affiliates: number;
    referralCodes: number;
    activeLinks: number;
    commissions: number;
    payouts: number;
  };
  commissionsByCurrency: CurrencyTotals[];
  payoutsByCurrency: PayoutCurrencyTotals[];
  productScopes: {
    unmappable: { productSourceId: string; codeSourceIds: string[]; reason: string }[];
    unreliableTargets: { productSourceId: string; targetProductId: string }[];
  };
  conflicts: {
    rate: PreviewConflict[];
    identity: PreviewConflict[];
    code: PreviewConflict[];
  };
};

export type AffiliateImportPreviewResult =
  | { ok: true; preview: AffiliateImportPreview }
  | { ok: false; issues: ImportValidationIssue[] };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function safeMappingChoices(
  choices: AffiliateImportMappingChoices | undefined,
  bundle: AffiliateProgramImportBundle,
  context: ImportPreviewContext,
  merchantId: string,
): { stored: { affiliateTargets: Record<string, string>; productTargets: Record<string, string> }; issues: ImportValidationIssue[] } {
  const issues: ImportValidationIssue[] = [];
  const stored = { affiliateTargets: {} as Record<string, string>, productTargets: {} as Record<string, string> };
  const affiliateSources = new Set(bundle.affiliates.map((row) => row.sourceId));
  const productSources = new Set(bundle.referralCodes.flatMap((row) => row.scope.kind === "product" ? [row.scope.productSourceId] : []));
  const affiliateTargets = choices?.affiliateTargets ?? {};
  const productTargets = choices?.productTargets ?? {};
  const affiliateTargetsById = new Map(context.affiliates.filter((row) => row.merchantId === merchantId).map((row) => [row.id, row]));
  const productTargetsById = new Map(context.products.filter((row) => row.merchantId === merchantId).map((row) => [row.id, row]));

  if (!choices || typeof choices !== "object" || Array.isArray(choices)) {
    if (choices !== undefined) issues.push({ path: "$.mappingChoices", message: "Mapping choices must be an object." });
  } else {
    for (const key of Object.keys(choices)) {
      if (key !== "affiliateTargets" && key !== "productTargets") issues.push({ path: "$.mappingChoices." + key, message: "Mapping choice is not supported." });
    }
  }

  for (const [sourceId, targetId] of Object.entries(affiliateTargets)) {
    const path = "$.mappingChoices.affiliateTargets." + sourceId;
    if (!SAFE_ID.test(sourceId) || !SAFE_ID.test(targetId) || !affiliateSources.has(sourceId)) {
      issues.push({ path, message: "Affiliate mapping identifier is invalid or unknown." });
      continue;
    }
    const target = affiliateTargetsById.get(targetId);
    if (!target) {
      issues.push({ path, message: "Affiliate mapping target does not belong to this Merchant." });
      continue;
    }
    stored.affiliateTargets[sourceId] = targetId;
  }
  for (const [sourceId, targetId] of Object.entries(productTargets)) {
    const path = "$.mappingChoices.productTargets." + sourceId;
    if (!SAFE_ID.test(sourceId) || !SAFE_ID.test(targetId) || !productSources.has(sourceId)) {
      issues.push({ path, message: "Product mapping identifier is invalid or unknown." });
      continue;
    }
    const target = productTargetsById.get(targetId);
    if (!target) {
      issues.push({ path, message: "Product mapping target does not belong to this Merchant." });
      continue;
    }
    stored.productTargets[sourceId] = targetId;
  }
  return { stored, issues };
}

function aggregateCommissions(bundle: AffiliateProgramImportBundle): CurrencyTotals[] {
  const totals = new Map<string, { gross: bigint; refunded: bigint }>();
  for (const row of bundle.commissions) {
    const total = totals.get(row.currency) ?? { gross: 0n, refunded: 0n };
    total.gross += BigInt(row.amountMinor);
    total.refunded += BigInt(row.refundedMinor);
    totals.set(row.currency, total);
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({
    currency,
    grossMinor: value.gross.toString(),
    refundedMinor: value.refunded.toString(),
    netMinor: (value.gross - value.refunded).toString(),
  }));
}

function aggregatePayouts(bundle: AffiliateProgramImportBundle): PayoutCurrencyTotals[] {
  const totals = new Map<string, bigint>();
  for (const row of bundle.payouts) totals.set(row.currency, (totals.get(row.currency) ?? 0n) + BigInt(row.amountMinor));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, totalMinor: total.toString() }));
}

function buildPreview(
  merchantId: string,
  bundle: AffiliateProgramImportBundle,
  context: ImportPreviewContext,
  mappings: { affiliateTargets: Record<string, string>; productTargets: Record<string, string> },
  now: Date,
): Omit<AffiliateImportPreview, "batchId" | "digest"> {
  const rate: PreviewConflict[] = [];
  const identity: PreviewConflict[] = [];
  const code: PreviewConflict[] = [];
  const localAffiliates = context.affiliates.filter((row) => row.merchantId === merchantId);
  const localAffiliatesById = new Map(localAffiliates.map((row) => [row.id, row]));
  const localAffiliateByEmail = new Map<string, (typeof localAffiliates)[number][]>();
  for (const affiliate of localAffiliates) {
    const normalizedEmail = affiliate.email?.toLowerCase();
    if (!normalizedEmail) continue;
    const matching = localAffiliateByEmail.get(normalizedEmail) ?? [];
    matching.push(affiliate);
    localAffiliateByEmail.set(normalizedEmail, matching);
  }
  const localCodes = new Set(context.referralCodes.filter((row) => row.merchantId === merchantId).map((row) => row.code.toLowerCase()));
  const productTargetsById = new Map(context.products.filter((row) => row.merchantId === merchantId).map((row) => [row.id, row]));
  const usedTargetIds = new Map<string, string>();

  for (const source of bundle.affiliates) {
    const chosenId = mappings.affiliateTargets[source.sourceId];
    const target = chosenId ? localAffiliatesById.get(chosenId) : undefined;
    if (chosenId && target) {
      const previousSource = usedTargetIds.get(chosenId);
      if (previousSource && previousSource !== source.sourceId) {
        identity.push({ sourceId: source.sourceId, targetId: chosenId, reason: "target_reused" });
      }
      usedTargetIds.set(chosenId, source.sourceId);
      if (source.email && target.email && source.email.toLowerCase() !== target.email.toLowerCase()) {
        identity.push({ sourceId: source.sourceId, targetId: target.id, reason: "email_mismatch" });
      }
      if (source.commissionRateBps !== undefined && target.commissionRateBps !== null && source.commissionRateBps !== target.commissionRateBps) {
        rate.push({ sourceId: source.sourceId, targetId: target.id, reason: "rate_mismatch" });
      }
    } else if (source.email) {
      const matching = source.email ? localAffiliateByEmail.get(source.email.toLowerCase()) : undefined;
      if (matching?.length) identity.push({ sourceId: source.sourceId, targetId: matching[0].id, reason: "email_requires_mapping" });
    }
  }

  for (const imported of bundle.referralCodes) {
    if (localCodes.has(imported.code.toLowerCase())) code.push({ sourceId: imported.sourceId, reason: "code_already_exists" });
  }

  const productGroups = new Map<string, string[]>();
  for (const link of bundle.referralCodes) {
    if (link.scope.kind !== "product") continue;
    const group = productGroups.get(link.scope.productSourceId) ?? [];
    group.push(link.sourceId);
    productGroups.set(link.scope.productSourceId, group);
  }
  const unmappable: AffiliateImportPreview["productScopes"]["unmappable"] = [];
  const unreliableTargets: AffiliateImportPreview["productScopes"]["unreliableTargets"] = [];
  for (const [productSourceId, codeSourceIds] of productGroups) {
    const targetId = mappings.productTargets[productSourceId];
    const target = targetId ? productTargetsById.get(targetId) : undefined;
    if (!targetId) unmappable.push({ productSourceId, codeSourceIds, reason: "mapping_required" });
    else if (!target) unmappable.push({ productSourceId, codeSourceIds, reason: "target_missing_or_out_of_scope" });
    else if (!target.trustworthy) {
      unmappable.push({ productSourceId, codeSourceIds, reason: "target_untrustworthy" });
      unreliableTargets.push({ productSourceId, targetProductId: target.id });
    }
  }

  const nowIso = now.toISOString();
  const nowCanonical = nowIso.slice(0, 19) + "." + nowIso.slice(20, 23).padEnd(9, "0") + "Z";
  const activeLinks = bundle.referralCodes.filter((row) => row.status === "active" &&
    (!row.activeFrom || row.activeFrom <= nowCanonical) &&
    (!row.activeUntil || row.activeUntil >= nowCanonical)).length;

  return {
    counts: {
      affiliates: bundle.affiliates.length,
      referralCodes: bundle.referralCodes.length,
      activeLinks,
      commissions: bundle.commissions.length,
      payouts: bundle.payouts.length,
    },
    commissionsByCurrency: aggregateCommissions(bundle),
    payoutsByCurrency: aggregatePayouts(bundle),
    productScopes: { unmappable, unreliableTargets },
    conflicts: { rate, identity, code },
  };
}

function toStoredTotals(preview: Omit<AffiliateImportPreview, "batchId" | "digest">): Record<string, unknown> {
  return {
    counts: preview.counts,
    commissionsByCurrency: preview.commissionsByCurrency,
    payoutsByCurrency: preview.payoutsByCurrency,
    conflictCounts: {
      rate: preview.conflicts.rate.length,
      identity: preview.conflicts.identity.length,
      code: preview.conflicts.code.length,
      unmappableProductScopes: preview.productScopes.unmappable.length,
      unreliableProductTargets: preview.productScopes.unreliableTargets.length,
    },
  };
}

async function savePreviewBatch(input: {
  merchantId: string;
  sourceAdapter: string;
  sourceFormatVersion: number;
  normalizedDigest: string;
  mappingChoices: Prisma.InputJsonValue;
  previewTotals: Prisma.InputJsonValue;
}): Promise<{ kind: "saved"; batchId: string } | { kind: "blocked"; status: string }> {
  const where = {
    merchantId_sourceAdapter_normalizedDigest: {
      merchantId: input.merchantId,
      sourceAdapter: input.sourceAdapter,
      normalizedDigest: input.normalizedDigest,
    },
  };
  const updateData = {
    sourceFormatVersion: input.sourceFormatVersion,
    mappingChoices: input.mappingChoices,
    previewTotals: input.previewTotals,
    status: "PREVIEW",
  };
  const existing = await db.affiliateImportBatch.findUnique({
    where,
    select: { id: true, status: true, completedAt: true },
  });
  if (existing) {
    if (existing.status !== "PREVIEW" || existing.completedAt !== null) {
      return { kind: "blocked", status: existing.status === "PREVIEW" ? "COMPLETED" : existing.status };
    }
    const updated = await db.affiliateImportBatch.updateMany({
      where: { id: existing.id, status: "PREVIEW", completedAt: null },
      data: updateData,
    });
    if (updated.count === 1) return { kind: "saved", batchId: existing.id };
    const current = await db.affiliateImportBatch.findUnique({ where: { id: existing.id }, select: { status: true, completedAt: true } });
    return { kind: "blocked", status: current?.status === "PREVIEW" && current.completedAt !== null ? "COMPLETED" : current?.status ?? "CHANGED" };
  }

  try {
    const created = await db.affiliateImportBatch.create({
      data: {
        merchantId: input.merchantId,
        sourceAdapter: input.sourceAdapter,
        sourceFormatVersion: input.sourceFormatVersion,
        normalizedDigest: input.normalizedDigest,
        mappingChoices: input.mappingChoices,
        previewTotals: input.previewTotals,
        status: "PREVIEW",
      },
      select: { id: true },
    });
    return { kind: "saved", batchId: created.id };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await db.affiliateImportBatch.findUnique({
      where,
      select: { id: true, status: true, completedAt: true },
    });
    if (!raced) throw error;
    if (raced.status !== "PREVIEW" || raced.completedAt !== null) {
      return { kind: "blocked", status: raced.status === "PREVIEW" ? "COMPLETED" : raced.status };
    }
    const updated = await db.affiliateImportBatch.updateMany({
      where: { id: raced.id, status: "PREVIEW", completedAt: null },
      data: updateData,
    });
    if (updated.count === 1) return { kind: "saved", batchId: raced.id };
    const current = await db.affiliateImportBatch.findUnique({ where: { id: raced.id }, select: { status: true, completedAt: true } });
    return { kind: "blocked", status: current?.status === "PREVIEW" && current.completedAt !== null ? "COMPLETED" : current?.status ?? "CHANGED" };
  }
}
export async function createAffiliateImportPreview(input: {
  merchantId: string;
  adapter: AffiliateImportAdapter;
  uploadedBundle: unknown;
  mappingChoices?: AffiliateImportMappingChoices;
  context: ImportPreviewContext;
  now?: Date;
}): Promise<AffiliateImportPreviewResult> {
  const uploadIssue = importUploadSizeIssue(input.uploadedBundle);
  if (uploadIssue) return { ok: false, issues: [uploadIssue] };
  const adapted = await input.adapter.toCanonicalBundle(input.uploadedBundle);
  const validated = validateAffiliateImportBundle(adapted);
  if (!validated.ok) return validated;
  if (!adapterSupportsBundle(input.adapter, validated.bundle)) {
    return { ok: false, issues: [{ path: "$.manifest", message: "Bundle adapter or version is not supported." }] };
  }
  if (!SAFE_ID.test(input.merchantId)) {
    return { ok: false, issues: [{ path: "$.merchantId", message: "Preview Merchant scope is invalid." }] };
  }
  const mappingResult = safeMappingChoices(input.mappingChoices, validated.bundle, input.context, input.merchantId);
  if (mappingResult.issues.length) return { ok: false, issues: mappingResult.issues };

  const summary = buildPreview(input.merchantId, validated.bundle, input.context, mappingResult.stored, input.now ?? new Date());
  const safeMappings = mappingResult.stored as Prisma.InputJsonValue;
  const safeTotals = toStoredTotals(summary) as Prisma.InputJsonValue;
  const saved = await savePreviewBatch({
    merchantId: input.merchantId,
    sourceAdapter: input.adapter.id,
    sourceFormatVersion: validated.bundle.manifest.version,
    normalizedDigest: validated.digest,
    mappingChoices: safeMappings,
    previewTotals: safeTotals,
  });
  if (saved.kind === "blocked") {
    const message = saved.status === "COMPLETED"
      ? "A batch for this digest is already completed; its report is read-only."
      : "A batch for this digest is in status " + saved.status + " and cannot be previewed.";
    return { ok: false, issues: [{ path: "$.manifest", message }] };
  }

  return { ok: true, preview: { batchId: saved.batchId, digest: validated.digest, ...summary } };
}







