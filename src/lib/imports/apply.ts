import { Prisma } from "@prisma/client";
import type { AffiliateProgramImportBundle, ImportedCommissionRow, ImportedPayoutSnapshot } from "@/lib/imports/canonical";
import { validateAffiliateImportBundle, importUploadSizeIssue } from "@/lib/imports/validate";
import { db } from "@/lib/db";
import { stableStringify } from "@/lib/imports/canonical";
import type { AffiliateImportAdapter } from "@/lib/imports/adapters/types";
import { adapterSupportsBundle } from "@/lib/imports/adapters/types";
import { getAffiliateImportAdapter } from "@/lib/imports/adapters/registry";

export type ImportTarget = { merchantId: string; programId: string };
export type AffiliateImportApplyChoices = {
  /** Maps each source product identity to one owner-owned Merchant and Program. */
  productTargets?: Record<string, ImportTarget>;
  /** Target for source links whose scope is Merchant-wide. */
  defaultTarget?: ImportTarget;
  /** Explicit, owner-selected identity links, scoped by source affiliate and target Merchant. */
  affiliateTargets?: Record<string, Record<string, string>>;
};

export type AffiliateImportApplyReport = {
  batchId: string;
  status: "COMPLETED" | "APPLYING" | "PREVIEW" | "FAILED";
  processed: { affiliates: number; links: number; commissions: number; payouts: number };
  merged: number;
  skipped: number;
  conflicts: number;
  unallocated: number;
  totalsByCurrency: { currency: string; commissionMinor: string; payoutMinor: string }[];
  samples: { skippedSourceIds: string[]; mergedSourceIds: string[]; conflictSourceIds: string[]; unallocatedSourceIds: string[] };
};

type Progress = {
  stage: "AFFILIATES" | "LINKS" | "FINALIZE_AFFILIATES" | "COMMISSIONS" | "PAYOUTS" | "DONE";
  effectiveAt: string;
  cursor: number;
  processed: AffiliateImportApplyReport["processed"];
  merged: number;
  skipped: number;
  conflicts: number;
  unallocated: number;
  totals: Record<string, { commissionMinor: string; payoutMinor: string }>;
  skippedIds: string[];
  mergedIds: string[];
  conflictIds: string[];
  unallocatedIds: string[];
};
type ApplyIndex = {
  targetsByAffiliate: Map<string, Map<string, ImportTarget>>;
  programsByAffiliate: Map<string, Map<string, Set<string>>>;
  codesById: Map<string, AffiliateProgramImportBundle["referralCodes"][number]>;
  commissionsById: Map<string, ImportedCommissionRow>;
};

const CHUNK_SIZE = 75;
const SAMPLE_LIMIT = 40;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readProgress(value: Prisma.JsonValue | null): Progress {
  const raw = asObject(value);
  const processed = asObject(raw.processed);
  const totals = asObject(raw.totals);
  return {
    stage: raw.stage === "LINKS" || raw.stage === "FINALIZE_AFFILIATES" || raw.stage === "COMMISSIONS" || raw.stage === "PAYOUTS" || raw.stage === "DONE" ? raw.stage : "AFFILIATES",
    effectiveAt: typeof raw.effectiveAt === "string" ? raw.effectiveAt : new Date().toISOString(),
    cursor: typeof raw.cursor === "number" && Number.isInteger(raw.cursor) && raw.cursor >= 0 ? raw.cursor : 0,
    processed: {
      affiliates: Number(processed.affiliates) || 0,
      links: Number(processed.links) || 0,
      commissions: Number(processed.commissions) || 0,
      payouts: Number(processed.payouts) || 0,
    },
    skipped: Number(raw.skipped) || 0,
    merged: Number(raw.merged) || 0,
    conflicts: Number(raw.conflicts) || 0,
    unallocated: Number(raw.unallocated) || 0,
    totals: Object.fromEntries(Object.entries(totals).map(([currency, item]) => {
      const value = asObject(item as Prisma.JsonValue);
      return [currency, { commissionMinor: String(value.commissionMinor ?? "0"), payoutMinor: String(value.payoutMinor ?? "0") }];
    })),
    skippedIds: Array.isArray(raw.skippedIds) ? raw.skippedIds.filter((v): v is string => typeof v === "string").slice(0, SAMPLE_LIMIT) : [],
    mergedIds: Array.isArray(raw.mergedIds) ? raw.mergedIds.filter((v): v is string => typeof v === "string").slice(0, SAMPLE_LIMIT) : [],
    conflictIds: Array.isArray(raw.conflictIds) ? raw.conflictIds.filter((v): v is string => typeof v === "string").slice(0, SAMPLE_LIMIT) : [],
    unallocatedIds: Array.isArray(raw.unallocatedIds) ? raw.unallocatedIds.filter((v): v is string => typeof v === "string").slice(0, SAMPLE_LIMIT) : [],
  };
}

function sample(list: string[], id: string): void {
  if (list.length < SAMPLE_LIMIT && !list.includes(id)) list.push(id);
}

function normalizeChoices(value: unknown): AffiliateImportApplyChoices {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mapping choices must match the saved preview.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["productTargets", "defaultTarget", "affiliateTargets"].includes(key))) throw new Error("Mapping choices contain unsupported fields.");
  const result: AffiliateImportApplyChoices = {};
  const productTargets = input.productTargets;
  if (productTargets !== undefined) {
    if (!productTargets || typeof productTargets !== "object" || Array.isArray(productTargets)) throw new Error("Product mappings must match the saved preview.");
    const rows = Object.fromEntries(Object.entries(productTargets as Record<string, unknown>).map(([key, target]) => [key, target]));
    if (Object.keys(rows).length) result.productTargets = rows as AffiliateImportApplyChoices["productTargets"];
  }
  const affiliateTargets = input.affiliateTargets;
  if (affiliateTargets !== undefined) {
    if (!affiliateTargets || typeof affiliateTargets !== "object" || Array.isArray(affiliateTargets)) throw new Error("Affiliate mappings must match the saved preview.");
    const rows: NonNullable<AffiliateImportApplyChoices["affiliateTargets"]> = {};
    for (const [sourceId, targets] of Object.entries(affiliateTargets as Record<string, unknown>)) {
      if (!targets || typeof targets !== "object" || Array.isArray(targets)) throw new Error("Affiliate mappings must match the saved preview.");
      const byMerchant = Object.fromEntries(Object.entries(targets as Record<string, unknown>));
      if (Object.keys(byMerchant).length) rows[sourceId] = byMerchant as Record<string, string>;
    }
    if (Object.keys(rows).length) result.affiliateTargets = rows;
  }
  if (input.defaultTarget !== undefined) result.defaultTarget = input.defaultTarget as ImportTarget;
  return result;
}

function targetForCode(code: AffiliateProgramImportBundle["referralCodes"][number], choices: AffiliateImportApplyChoices): ImportTarget | null {
  return code.scope.kind === "merchant" ? choices.defaultTarget ?? null : choices.productTargets?.[code.scope.productSourceId] ?? null;
}

function isLiveCode(code: AffiliateProgramImportBundle["referralCodes"][number], now: Date): boolean {
  return code.status === "active" && (!code.activeFrom || new Date(code.activeFrom) <= now) && (!code.activeUntil || new Date(code.activeUntil) >= now);
}

function buildApplyIndex(bundle: AffiliateProgramImportBundle, choices: AffiliateImportApplyChoices, now: Date): ApplyIndex {
  const targetsByAffiliate = new Map<string, Map<string, ImportTarget>>();
  const programsByAffiliate = new Map<string, Map<string, Set<string>>>();
  for (const code of bundle.referralCodes) {
    if (!isLiveCode(code, now)) continue;
    const target = targetForCode(code, choices);
    if (!target) continue;
    const byMerchant = targetsByAffiliate.get(code.affiliateSourceId) ?? new Map<string, ImportTarget>();
    byMerchant.set(target.merchantId, target);
    targetsByAffiliate.set(code.affiliateSourceId, byMerchant);
    const programs = programsByAffiliate.get(code.affiliateSourceId) ?? new Map<string, Set<string>>();
    const programIds = programs.get(target.merchantId) ?? new Set<string>();
    programIds.add(target.programId);
    programs.set(target.merchantId, programIds);
    programsByAffiliate.set(code.affiliateSourceId, programs);
  }
  return {
    targetsByAffiliate,
    programsByAffiliate,
    codesById: new Map(bundle.referralCodes.map((row) => [row.sourceId, row])),
    commissionsById: new Map(bundle.commissions.map((row) => [row.sourceId, row])),
  };
}

async function validateChoices(ownerId: string, bundle: AffiliateProgramImportBundle, choices: AffiliateImportApplyChoices, effectiveAt: Date): Promise<string | null> {
  const sourceAffiliates = new Set(bundle.affiliates.map((row) => row.sourceId));
  const sourceAffiliateById = new Map(bundle.affiliates.map((row) => [row.sourceId, row]));
  const sourceProducts = new Set(bundle.referralCodes.flatMap((row) => row.scope.kind === "product" ? [row.scope.productSourceId] : []));
  const targets = new Map<string, ImportTarget>();
  for (const [productId, target] of Object.entries(choices.productTargets ?? {})) {
    if (!SAFE_ID.test(productId) || !sourceProducts.has(productId) || !target || !SAFE_ID.test(target.merchantId) || !SAFE_ID.test(target.programId)) return "A product mapping is invalid.";
    targets.set(target.merchantId + ":" + target.programId, target);
  }
  if (choices.defaultTarget) {
    if (!SAFE_ID.test(choices.defaultTarget.merchantId) || !SAFE_ID.test(choices.defaultTarget.programId)) return "The Merchant-wide link mapping is invalid.";
    targets.set(choices.defaultTarget.merchantId + ":" + choices.defaultTarget.programId, choices.defaultTarget);
  }
  const targetRows = await db.merchant.findMany({
    where: { ownerId, id: { in: [...new Set([...targets.values()].map((target) => target.merchantId))] } },
    select: { id: true, trackingVerifiedAt: true, programs: { select: { id: true } } },
  });
  const programs = new Set(targetRows.flatMap((merchant) => merchant.programs.map((program) => `${merchant.id}:${program.id}`)));
  const targetMerchantIds = new Set(targetRows.map((row) => row.id));
  for (const key of targets.keys()) if (!programs.has(key)) return "Each target Program must belong to a Merchant owned by this account.";
  if (targetRows.some((merchant) => merchant.trackingVerifiedAt === null)) return "Live imported links require tracking verification on every target Merchant. Leave unverified targets unallocated.";
  const targetsByAffiliate = new Map<string, Map<string, ImportTarget>>();
  const programsByAffiliate = new Map<string, Map<string, Set<string>>>();
  for (const code of bundle.referralCodes) {
    if (!isLiveCode(code, effectiveAt)) continue;
    const target = targetForCode(code, choices);
    if (!target) continue;
    const byMerchant = targetsByAffiliate.get(code.affiliateSourceId) ?? new Map<string, ImportTarget>();
    byMerchant.set(target.merchantId, target);
    targetsByAffiliate.set(code.affiliateSourceId, byMerchant);
    const byProgram = programsByAffiliate.get(code.affiliateSourceId) ?? new Map<string, Set<string>>();
    const ids = byProgram.get(target.merchantId) ?? new Set<string>();
    ids.add(target.programId);
    byProgram.set(target.merchantId, ids);
    programsByAffiliate.set(code.affiliateSourceId, byProgram);
  }
  for (const [sourceAffiliateId, byMerchant] of Object.entries(choices.affiliateTargets ?? {})) {
    if (!sourceAffiliates.has(sourceAffiliateId)) return "An affiliate mapping references an unknown source identity.";
    for (const [merchantId, affiliateId] of Object.entries(byMerchant)) {
      if (!SAFE_ID.test(merchantId) || !SAFE_ID.test(affiliateId)) return "An affiliate mapping target is invalid.";
      const sourceMerchantTargets = targetsByAffiliate.get(sourceAffiliateId)?.get(merchantId);
      if (!sourceMerchantTargets || !targetMerchantIds.has(merchantId)) return "An affiliate mapping target is outside the selected products.";
      if ((programsByAffiliate.get(sourceAffiliateId)?.get(merchantId)?.size ?? 0) !== 1) return "The source Affiliate maps to more than one Program in this Merchant.";
    }
  }
  const affiliateIds = Object.values(choices.affiliateTargets ?? {}).flatMap((byMerchant) => Object.values(byMerchant));
  const affiliates = await db.affiliate.findMany({ where: { id: { in: affiliateIds }, merchant: { ownerId } }, select: { id: true, merchantId: true, programId: true, email: true } });
  const affiliateByKey = new Map(affiliates.map((row) => [`${row.merchantId}:${row.id}`, row]));
  for (const [sourceId, byMerchant] of Object.entries(choices.affiliateTargets ?? {})) {
    for (const [merchantId, affiliateId] of Object.entries(byMerchant)) {
      const targetProgramId = targetsByAffiliate.get(sourceId)?.get(merchantId)?.programId;
      const selected = affiliateByKey.get(`${merchantId}:${affiliateId}`);
      const source = sourceAffiliateById.get(sourceId);
      const sourceEmail = source?.email?.trim().toLowerCase();
      const targetEmail = selected?.email.trim().toLowerCase();
      if (!sourceAffiliates.has(sourceId) || !selected || selected.programId !== targetProgramId || !sourceEmail || targetEmail !== sourceEmail) {
        return "Choose an existing Affiliate in the mapped Merchant and Program.";
      }
    }
  }
  return null;
}

function decimalFromMinor(amountMinor: string, currency: string): Prisma.Decimal {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  const amount = BigInt(amountMinor);
  if (digits === 0) return new Prisma.Decimal(amount.toString());
  const scale = 10n ** BigInt(digits);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(digits, "0");
  return new Prisma.Decimal(`${whole}.${fraction}`);
}

function percentageFromBps(bps: number | undefined): Prisma.Decimal | null {
  return bps === undefined ? null : new Prisma.Decimal(bps).div(100).toDecimalPlaces(2);
}

function sourceIdentity(batchId: string, kind: string, sourceId: string, targetMerchantId?: string): string {
  return [batchId, kind, sourceId, targetMerchantId].filter(Boolean).join(":");
}

function report(batchId: string, status: AffiliateImportApplyReport["status"], progress: Progress): AffiliateImportApplyReport {
  return {
    batchId,
    status,
    processed: progress.processed,
    merged: progress.merged,
    skipped: progress.skipped,
    conflicts: progress.conflicts,
    unallocated: progress.unallocated,
    totalsByCurrency: Object.entries(progress.totals).sort(([a], [b]) => a.localeCompare(b)).map(([currency, totals]) => ({ currency, ...totals })),
    samples: { skippedSourceIds: progress.skippedIds, mergedSourceIds: progress.mergedIds, conflictSourceIds: progress.conflictIds, unallocatedSourceIds: progress.unallocatedIds },
  };
}

function incrementTotal(progress: Progress, currency: string, field: "commissionMinor" | "payoutMinor", amount: string): void {
  const total = progress.totals[currency] ?? { commissionMinor: "0", payoutMinor: "0" };
  total[field] = (BigInt(total[field]) + BigInt(amount)).toString();
  progress.totals[currency] = total;
}

type RowResultInput = {
  sourceIdentity: string;
  sourceKind: "AFFILIATE" | "LINK" | "COMMISSION" | "PAYOUT";
  sourceId: string;
  outcome: "IMPORTED" | "MERGED" | "SKIPPED" | "CONFLICT" | "UNALLOCATED";
  targetMerchantId?: string | null;
  reason?: string;
  currency?: string;
  amountMinor?: bigint;
};

async function recordRowResults(tx: Prisma.TransactionClient, batchId: string, ownerId: string, rows: RowResultInput[]): Promise<void> {
  if (!rows.length) return;
  await tx.affiliateImportRowResult.createMany({
    data: rows.map((row) => ({
      batchId, ownerId,
      sourceIdentity: row.sourceIdentity,
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      outcome: row.outcome,
      targetMerchantId: row.targetMerchantId ?? null,
      targetOwnerId: row.targetMerchantId ? ownerId : null,
      reason: row.reason ?? null,
      currency: row.currency ?? null,
      amountMinor: row.amountMinor ?? null,
    })),
    skipDuplicates: true,
  });
}

async function lockCodes(tx: Prisma.TransactionClient, merchantId: string, codes: string[]): Promise<void> {
  const sorted = [...new Set(codes.map((code) => code.toLowerCase()))].sort();
  for (let offset = 0; offset < sorted.length; offset += 1000) {
    const chunk = sorted.slice(offset, offset + 1000);
    await tx.$queryRaw`
      WITH ordered_codes AS MATERIALIZED (
        SELECT code FROM unnest(ARRAY[${Prisma.join(chunk)}]::text[]) AS input_codes(code)
        ORDER BY lower(code)
      )
      SELECT pg_advisory_xact_lock(hashtextextended('link-code:' || ${merchantId} || ':' || lower(ordered_codes.code), 0))
      FROM ordered_codes
      ORDER BY lower(ordered_codes.code)`;
  }
}

async function processAffiliateChunk(tx: Prisma.TransactionClient, batchId: string, bundle: AffiliateProgramImportBundle, choices: AffiliateImportApplyChoices, progress: Progress, index: ApplyIndex): Promise<void> {
  const slice = bundle.affiliates.slice(progress.cursor, progress.cursor + CHUNK_SIZE);
  const candidates: { sourceId: string; merchantId: string; email: string; programId: string; name: string | null; rate: Prisma.Decimal | null }[] = [];
  const emailSets = new Map<string, Set<string>>();
  for (const source of slice) {
    const byMerchant = index.targetsByAffiliate.get(source.sourceId);
    const merchants = byMerchant ? new Set(byMerchant.keys()) : undefined;
    if (!merchants?.size) { progress.skipped++; sample(progress.skippedIds, source.sourceId); continue; }
    for (const merchantId of merchants) {
      if (choices.affiliateTargets?.[source.sourceId]?.[merchantId]) { progress.merged++; sample(progress.mergedIds, source.sourceId); continue; }
      if (!source.email) { progress.skipped++; sample(progress.skippedIds, source.sourceId); continue; }
      const ids = index.programsByAffiliate.get(source.sourceId)?.get(merchantId);
      if (!ids || ids.size !== 1) { progress.conflicts++; sample(progress.conflictIds, source.sourceId); continue; }
      candidates.push({ sourceId: source.sourceId, merchantId, email: source.email, programId: [...ids][0], name: source.displayName ?? null, rate: percentageFromBps(source.commissionRateBps) });
      const emails = emailSets.get(merchantId) ?? new Set<string>();
      emails.add(source.email);
      emailSets.set(merchantId, emails);
    }
  }
  const existingEmails = new Set<string>();
  for (const [merchantId, emails] of emailSets) {
    const existing = await tx.affiliate.findMany({ where: { merchantId, email: { in: [...emails], mode: "insensitive" } }, select: { merchantId: true, email: true } });
    for (const row of existing) existingEmails.add(`${row.merchantId}:${row.email.toLowerCase()}`);
  }
  const createRows: Prisma.AffiliateCreateManyInput[] = [];
  for (const candidate of candidates) {
    if (existingEmails.has(`${candidate.merchantId}:${candidate.email.toLowerCase()}`)) { progress.conflicts++; sample(progress.conflictIds, candidate.sourceId); continue; }
    createRows.push({
      merchantId: candidate.merchantId,
      programId: candidate.programId,
      email: candidate.email,
      name: candidate.name,
      passwordHash: null,
      payoutDetails: null,
      customCommissionRate: candidate.rate,
      importSourceIdentity: sourceIdentity(batchId, "affiliate", candidate.sourceId, candidate.merchantId),
    });
  }
  if (createRows.length) await tx.affiliate.createMany({ data: createRows, skipDuplicates: true });
  progress.processed.affiliates += slice.length;
  progress.cursor += slice.length;
  if (progress.cursor >= bundle.affiliates.length) { progress.stage = "LINKS"; progress.cursor = 0; }
}

async function processLinkChunk(tx: Prisma.TransactionClient, batchId: string, ownerId: string, bundle: AffiliateProgramImportBundle, choices: AffiliateImportApplyChoices, adapter: AffiliateImportAdapter, progress: Progress): Promise<void> {
  const now = new Date(progress.effectiveAt);
  const slice = bundle.referralCodes.slice(progress.cursor, progress.cursor + CHUNK_SIZE);
  const eligible = slice.filter((row) => isLiveCode(row, now));
  const results: RowResultInput[] = [];
  for (const row of slice) if (!isLiveCode(row, now)) {
    progress.skipped++; sample(progress.skippedIds, row.sourceId);
    results.push({ sourceIdentity: sourceIdentity(batchId, "link", row.sourceId), sourceKind: "LINK", sourceId: row.sourceId, outcome: "SKIPPED", reason: "Link was inactive or outside its active dates." });
  }
  for (const row of eligible) {
    const target = targetForCode(row, choices);
    if (!target) {
      progress.unallocated++; sample(progress.unallocatedIds, row.sourceId);
      results.push({ sourceIdentity: sourceIdentity(batchId, "link", row.sourceId), sourceKind: "LINK", sourceId: row.sourceId, outcome: "UNALLOCATED", reason: "No target Merchant and Program were selected." });
      continue;
    }
    const identity = sourceIdentity(batchId, "link", row.sourceId, target.merchantId);
    const verifiedTarget = await tx.merchant.findFirst({ where: { id: target.merchantId, ownerId }, select: { trackingVerifiedAt: true } });
    if (!verifiedTarget || verifiedTarget.trackingVerifiedAt === null) {
      progress.unallocated++; sample(progress.unallocatedIds, row.sourceId);
      results.push({ sourceIdentity: identity, sourceKind: "LINK", sourceId: row.sourceId, targetMerchantId: target.merchantId, outcome: "UNALLOCATED", reason: "Target Merchant tracking is not verified." });
      continue;
    }
    const existingImported = await tx.affiliateLink.findUnique({ where: { importSourceIdentity: identity }, select: { id: true } });
    if (existingImported) {
      results.push({ sourceIdentity: identity, sourceKind: "LINK", sourceId: row.sourceId, targetMerchantId: target.merchantId, outcome: "IMPORTED" });
      continue;
    }
    const ownerAffiliate = choices.affiliateTargets?.[row.affiliateSourceId]?.[target.merchantId];
    const affiliate = ownerAffiliate
      ? await tx.affiliate.findFirst({ where: { id: ownerAffiliate, merchantId: target.merchantId }, select: { id: true } })
      : await tx.affiliate.findUnique({ where: { importSourceIdentity: sourceIdentity(batchId, "affiliate", row.affiliateSourceId, target.merchantId) }, select: { id: true } });
    if (!affiliate) {
      progress.skipped++; sample(progress.skippedIds, row.sourceId);
      results.push({ sourceIdentity: identity, sourceKind: "LINK", sourceId: row.sourceId, targetMerchantId: target.merchantId, outcome: "SKIPPED", reason: "No applicable affiliate identity is available." });
      continue;
    }
    const code = row.code.toLowerCase();
    const aliases = (row.legacyAliases ?? []).map((alias) => alias.toLowerCase());
    const names = [code, ...aliases];
    await lockCodes(tx, target.merchantId, names);
    const collisions = await tx.affiliateLink.findMany({
      where: { merchantId: target.merchantId, OR: [{ code: { in: names } }, { legacyAliases: { hasSome: names } }] },
      select: { code: true, legacyAliases: true },
    });
    const retired = await tx.retiredLinkCode.findMany({ where: { merchantId: target.merchantId, code: { in: names } }, select: { code: true, affiliateId: true } });
    const occupied = new Set([
      ...collisions.flatMap((link) => [link.code, ...link.legacyAliases]),
      ...retired.filter((item) => item.affiliateId !== affiliate.id).map((item) => item.code),
    ].map((code) => code.toLowerCase()));
    if (names.some((name) => occupied.has(name)) || new Set(names).size !== names.length) {
      progress.conflicts++; sample(progress.conflictIds, row.sourceId);
      results.push({ sourceIdentity: identity, sourceKind: "LINK", sourceId: row.sourceId, targetMerchantId: target.merchantId, outcome: "CONFLICT", reason: "The code or one of its aliases is already in use or retired." });
      continue;
    }
    const isPrimary = (await tx.affiliateLink.count({ where: { affiliateId: affiliate.id, isPrimary: true } })) === 0;
    await tx.affiliateLink.create({ data: {
      merchantId: target.merchantId,
      affiliateId: affiliate.id,
      code,
      legacyAliases: aliases,
      legacyQueryParamAliases: [...new Set((adapter.legacyQueryParamAliases ?? [])
        .map((name) => name.toLowerCase())
        .filter((name) => name !== "via" && name !== "token"))],
      isPrimary,
      importSourceIdentity: identity,
      commissionRateOverride: percentageFromBps(row.commissionRateOverrideBps),
      activeFrom: row.activeFrom ? new Date(row.activeFrom) : null,
      activeUntil: row.activeUntil ? new Date(row.activeUntil) : null,
    } });
    await tx.retiredLinkCode.deleteMany({ where: { merchantId: target.merchantId, affiliateId: affiliate.id, code: { in: names } } });
    results.push({ sourceIdentity: identity, sourceKind: "LINK", sourceId: row.sourceId, targetMerchantId: target.merchantId, outcome: "IMPORTED" });
  }
  await recordRowResults(tx, batchId, ownerId, results);
  progress.processed.links += slice.length;
  progress.cursor += slice.length;
  if (progress.cursor >= bundle.referralCodes.length) {
    // Remove only affiliates created by this batch that have no live link.
    // Explicitly selected existing Affiliates never carry this batch identity.
    await tx.affiliate.deleteMany({
      where: {
        importSourceIdentity: { startsWith: `${batchId}:affiliate:` },
        links: { none: {} },
      },
    });
    progress.stage = "FINALIZE_AFFILIATES";
    progress.cursor = 0;
  }
}

async function finalizeAffiliateChunk(tx: Prisma.TransactionClient, batchId: string, ownerId: string, bundle: AffiliateProgramImportBundle, choices: AffiliateImportApplyChoices, progress: Progress, index: ApplyIndex): Promise<void> {
  const slice = bundle.affiliates.slice(progress.cursor, progress.cursor + CHUNK_SIZE);
  const pairs: { sourceId: string; merchantId: string; email: string | null; identity: string; selectedId?: string }[] = [];
  const rows: RowResultInput[] = [];
  for (const source of slice) {
    const merchants = [...(index.targetsByAffiliate.get(source.sourceId)?.keys() ?? [])].sort();
    if (!merchants.length) {
      rows.push({ sourceIdentity: sourceIdentity(batchId, "affiliate", source.sourceId), sourceKind: "AFFILIATE", sourceId: source.sourceId, outcome: "SKIPPED", reason: "No active link has a selected target." });
      continue;
    }
    for (const merchantId of merchants) {
      pairs.push({ sourceId: source.sourceId, merchantId, email: source.email?.toLowerCase() ?? null,
        identity: sourceIdentity(batchId, "affiliate", source.sourceId, merchantId),
        selectedId: choices.affiliateTargets?.[source.sourceId]?.[merchantId] });
    }
  }
  const identities = pairs.map((pair) => pair.identity);
  const imported = identities.length ? await tx.affiliate.findMany({ where: { importSourceIdentity: { in: identities } }, select: { id: true, importSourceIdentity: true } }) : [];
  const importedByIdentity = new Map(imported.map((row) => [row.importSourceIdentity!, row.id]));
  const importedIds = imported.map((row) => row.id);
  const linkCounts = importedIds.length ? await tx.affiliateLink.groupBy({ by: ["affiliateId"], where: { affiliateId: { in: importedIds } }, _count: { _all: true } }) : [];
  const linkedIds = new Set(linkCounts.filter((row) => row._count._all > 0).map((row) => row.affiliateId));
  const merchantIds = [...new Set(pairs.map((pair) => pair.merchantId))];
  const emails = [...new Set(pairs.flatMap((pair) => pair.email ? [pair.email] : []))];
  const existingEmails = merchantIds.length && emails.length ? await tx.affiliate.findMany({ where: { merchantId: { in: merchantIds }, email: { in: emails, mode: "insensitive" } }, select: { merchantId: true, email: true } }) : [];
  const emailKeys = new Set(existingEmails.map((row) => `${row.merchantId}:${row.email.toLowerCase()}`));
  for (const pair of pairs) {
    if (pair.selectedId) {
      rows.push({ sourceIdentity: pair.identity, sourceKind: "AFFILIATE", sourceId: pair.sourceId, targetMerchantId: pair.merchantId, outcome: "MERGED", reason: "Linked to the existing account selected by the Owner." });
      continue;
    }
    if ((index.programsByAffiliate.get(pair.sourceId)?.get(pair.merchantId)?.size ?? 0) !== 1) {
      rows.push({ sourceIdentity: pair.identity, sourceKind: "AFFILIATE", sourceId: pair.sourceId, targetMerchantId: pair.merchantId, outcome: "CONFLICT", reason: "The source affiliate maps to multiple Programs in this Merchant." });
      continue;
    }
    const createdId = importedByIdentity.get(pair.identity);
    if (createdId && linkedIds.has(createdId)) {
      rows.push({ sourceIdentity: pair.identity, sourceKind: "AFFILIATE", sourceId: pair.sourceId, targetMerchantId: pair.merchantId, outcome: "IMPORTED" });
    } else if (pair.email && emailKeys.has(`${pair.merchantId}:${pair.email}`)) {
      rows.push({ sourceIdentity: pair.identity, sourceKind: "AFFILIATE", sourceId: pair.sourceId, targetMerchantId: pair.merchantId, outcome: "CONFLICT", reason: "An account with this email already exists; select it explicitly to merge." });
    } else {
      rows.push({ sourceIdentity: pair.identity, sourceKind: "AFFILIATE", sourceId: pair.sourceId, targetMerchantId: pair.merchantId, outcome: "SKIPPED", reason: pair.email ? "No live link was created for this affiliate." : "A source email is required to create an account." });
    }
  }
  await recordRowResults(tx, batchId, ownerId, rows);
  progress.cursor += slice.length;
  if (progress.cursor >= bundle.affiliates.length) { progress.stage = "COMMISSIONS"; progress.cursor = 0; }
}

function commissionTarget(row: ImportedCommissionRow, codes: Map<string, AffiliateProgramImportBundle["referralCodes"][number]>, choices: AffiliateImportApplyChoices): ImportTarget | null {
  const code = row.referralCodeSourceId ? codes.get(row.referralCodeSourceId) : undefined;
  return code ? targetForCode(code, choices) : null;
}

async function processCommissionChunk(tx: Prisma.TransactionClient, batchId: string, ownerId: string, bundle: AffiliateProgramImportBundle, choices: AffiliateImportApplyChoices, progress: Progress, index: ApplyIndex): Promise<void> {
  const slice = bundle.commissions.slice(progress.cursor, progress.cursor + CHUNK_SIZE);
  const codes = index.codesById;
  const rows: Prisma.ImportedCommissionCreateManyInput[] = [];
  const reportRows: RowResultInput[] = [];
  for (const row of slice) {
    const target = commissionTarget(row, codes, choices);
    const affiliateId = target ? choices.affiliateTargets?.[row.affiliateSourceId]?.[target.merchantId] ??
      (await tx.affiliate.findUnique({ where: { importSourceIdentity: sourceIdentity(batchId, "affiliate", row.affiliateSourceId, target.merchantId) }, select: { id: true } }))?.id : undefined;
    const allocated = Boolean(target);
    rows.push({
      batchId, ownerId,
      merchantId: allocated ? target!.merchantId : null,
      targetOwnerId: allocated ? ownerId : null,
      affiliateId: allocated ? affiliateId ?? null : null,
      targetProgramId: allocated ? target!.programId : null,
      sourceIdentity: sourceIdentity(batchId, "commission", row.sourceId),
      sourceAffiliateIdentity: row.affiliateSourceId,
      sourceLinkIdentity: row.referralCodeSourceId ?? null,
      sourceProductIdentity: codes.get(row.referralCodeSourceId ?? "")?.scope.kind === "product" ? (codes.get(row.referralCodeSourceId!)!.scope as { kind: "product"; productSourceId: string }).productSourceId : null,
      sourceTransactionRef: row.sourceTransactionId ?? row.sourceOrderId ?? null,
      amount: decimalFromMinor(row.amountMinor, row.currency), amountMinor: BigInt(row.amountMinor),
      refundedAmount: decimalFromMinor(row.refundedMinor, row.currency), refundedMinor: BigInt(row.refundedMinor),
      refunds: row.refunds ? row.refunds.map((refund) => ({ sourceId: refund.sourceId, occurredAt: refund.occurredAt, amountMinor: refund.amountMinor })) as Prisma.InputJsonValue : Prisma.JsonNull,
      saleAmount: row.saleAmountMinor ? decimalFromMinor(row.saleAmountMinor, row.currency) : null,
      saleAmountMinor: row.saleAmountMinor ? BigInt(row.saleAmountMinor) : null,
      currency: row.currency,
      originalStatus: row.status,
      allocationStatus: allocated ? "ALLOCATED" : "UNALLOCATED",
      sourceCreatedAt: new Date(row.occurredAt),
    });
    if (!allocated) { progress.unallocated++; sample(progress.unallocatedIds, row.sourceId); }
    reportRows.push({
      sourceIdentity: sourceIdentity(batchId, "commission", row.sourceId), sourceKind: "COMMISSION", sourceId: row.sourceId,
      targetMerchantId: allocated ? target!.merchantId : null, outcome: allocated ? "IMPORTED" : "UNALLOCATED",
      reason: allocated ? undefined : "The source link has no selected target Merchant and Program.", currency: row.currency, amountMinor: BigInt(row.amountMinor),
    });
    incrementTotal(progress, row.currency, "commissionMinor", row.amountMinor);
  }
  if (rows.length) await tx.importedCommission.createMany({ data: rows, skipDuplicates: true });
  await recordRowResults(tx, batchId, ownerId, reportRows);
  progress.processed.commissions += slice.length;
  progress.cursor += slice.length;
  if (progress.cursor >= bundle.commissions.length) { progress.stage = "PAYOUTS"; progress.cursor = 0; }
}

async function processPayoutChunk(tx: Prisma.TransactionClient, batchId: string, ownerId: string, bundle: AffiliateProgramImportBundle, choices: AffiliateImportApplyChoices, progress: Progress, index: ApplyIndex): Promise<void> {
  const slice = bundle.payouts.slice(progress.cursor, progress.cursor + CHUNK_SIZE);
  const commissionById = index.commissionsById;
  const codes = index.codesById;
  const rows: Prisma.ImportedPayoutCreateManyInput[] = [];
  const reportRows: RowResultInput[] = [];
  for (const row of slice) {
    const referenced = row.sourceCommissionIds.map((id) => commissionById.get(id));
    const targets = referenced.filter((value): value is ImportedCommissionRow => Boolean(value)).map((commission) => commissionTarget(commission, codes, choices));
    const targetKeys = new Set(targets.filter((target): target is ImportTarget => Boolean(target)).map((target) => `${target.merchantId}:${target.programId}`));
    const complete = referenced.length > 0 && referenced.every(Boolean) && targets.every(Boolean) && targetKeys.size === 1;
    const target = complete ? targets[0] : null;
    const affiliateId = target ? choices.affiliateTargets?.[row.affiliateSourceId]?.[target.merchantId] ??
      (await tx.affiliate.findUnique({ where: { importSourceIdentity: sourceIdentity(batchId, "affiliate", row.affiliateSourceId, target.merchantId) }, select: { id: true } }))?.id : undefined;
    const allocated = Boolean(target);
    rows.push({
      batchId, ownerId,
      merchantId: allocated ? target!.merchantId : null,
      targetOwnerId: allocated ? ownerId : null,
      affiliateId: allocated ? affiliateId ?? null : null,
      targetProgramId: allocated ? target!.programId : null,
      sourceIdentity: sourceIdentity(batchId, "payout", row.sourceId),
      sourceAffiliateIdentity: row.affiliateSourceId,
      sourceProductIdentity: null,
      sourceCommissionIdentities: row.sourceCommissionIds.map((id) => sourceIdentity(batchId, "commission", id)),
      amount: decimalFromMinor(row.amountMinor, row.currency), amountMinor: BigInt(row.amountMinor),
      currency: row.currency, originalStatus: row.status,
      allocationStatus: allocated ? "ALLOCATED" : "UNALLOCATED",
      periodStart: new Date(row.periodStart), periodEnd: new Date(row.periodEnd), paidAt: new Date(row.paidAt),
    });
    if (!allocated) { progress.unallocated++; sample(progress.unallocatedIds, row.sourceId); }
    reportRows.push({
      sourceIdentity: sourceIdentity(batchId, "payout", row.sourceId), sourceKind: "PAYOUT", sourceId: row.sourceId,
      targetMerchantId: allocated ? target!.merchantId : null, outcome: allocated ? "IMPORTED" : "UNALLOCATED",
      reason: allocated ? undefined : "The payout references commissions that do not all map to one target Merchant and Program.", currency: row.currency, amountMinor: BigInt(row.amountMinor),
    });
    incrementTotal(progress, row.currency, "payoutMinor", row.amountMinor);
  }
  if (rows.length) await tx.importedPayout.createMany({ data: rows, skipDuplicates: true });
  await recordRowResults(tx, batchId, ownerId, reportRows);
  progress.processed.payouts += slice.length;
  progress.cursor += slice.length;
  if (progress.cursor >= bundle.payouts.length) { progress.stage = "DONE"; progress.cursor = 0; }
}

async function runChunk(input: { batchId: string; ownerId: string; sourceMerchantId: string; bundle: AffiliateProgramImportBundle; choices: AffiliateImportApplyChoices; adapter: AffiliateImportAdapter; index: ApplyIndex }): Promise<AffiliateImportApplyReport> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string; ownerId: string; merchantId: string; applyProgress: Prisma.JsonValue | null }[]>`
      SELECT "id", "status", "ownerId", "merchantId", "applyProgress" FROM "AffiliateImportBatch"
      WHERE "id" = ${input.batchId} AND "ownerId" = ${input.ownerId} AND "merchantId" = ${input.sourceMerchantId}
      FOR UPDATE`;
    const batch = locked[0];
    if (!batch) throw new Error("Import batch not found.");
    if (batch.status === "COMPLETED") return report(batch.id, "COMPLETED", readProgress(batch.applyProgress));
    if (batch.status !== "APPLYING") throw new Error(`Import batch cannot continue from ${batch.status}.`);
    const progress = readProgress(batch.applyProgress);
    if (progress.stage === "AFFILIATES") await processAffiliateChunk(tx, batch.id, input.bundle, input.choices, progress, input.index);
    else if (progress.stage === "LINKS") await processLinkChunk(tx, batch.id, input.ownerId, input.bundle, input.choices, input.adapter, progress);
    else if (progress.stage === "FINALIZE_AFFILIATES") await finalizeAffiliateChunk(tx, batch.id, input.ownerId, input.bundle, input.choices, progress, input.index);
    else if (progress.stage === "COMMISSIONS") await processCommissionChunk(tx, batch.id, input.ownerId, input.bundle, input.choices, progress, input.index);
    else if (progress.stage === "PAYOUTS") await processPayoutChunk(tx, batch.id, input.ownerId, input.bundle, input.choices, progress, input.index);
    if (progress.stage === "DONE") {
      const finalReport = report(batch.id, "COMPLETED", progress);
      await tx.affiliateImportBatch.update({ where: { id: batch.id }, data: {
        status: "COMPLETED", completedAt: new Date(), applyProgress: progress as unknown as Prisma.InputJsonValue,
        previewTotals: { ...asObject(await tx.affiliateImportBatch.findUnique({ where: { id: batch.id }, select: { previewTotals: true } }).then((row) => row?.previewTotals ?? null)), applyReport: finalReport } as Prisma.InputJsonValue,
      } });
      return finalReport;
    }
    await tx.affiliateImportBatch.update({ where: { id: batch.id }, data: { applyProgress: progress as unknown as Prisma.InputJsonValue } });
    return report(batch.id, "APPLYING", progress);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/**
 * Confirms and resumes an import. The same canonical bundle must be uploaded
 * again; its contents are never stored. Every chunk commits its archive rows
 * and cursor together so a retry cannot skip or duplicate a historical row.
 */
export async function applyAffiliateImportBatch(input: {
  ownerId: string;
  sourceMerchantId: string;
  batchId: string;
  adapterId: string;
  adapter: AffiliateImportAdapter;
  uploadedBundle: unknown;
  mappingChoices?: AffiliateImportApplyChoices;
  maxChunks?: number;
}): Promise<AffiliateImportApplyReport> {
  const sizeIssue = importUploadSizeIssue(input.uploadedBundle);
  if (sizeIssue) throw new Error(sizeIssue.message);
  const adapter = getAffiliateImportAdapter(input.adapterId);
  if (!adapter || adapter !== input.adapter || adapter.id !== input.adapterId) throw new Error("This import adapter is not registered on the server.");
  let canonicalPayload: unknown;
  try { canonicalPayload = await adapter.toCanonicalBundle(input.uploadedBundle); }
  catch { throw new Error("The selected import adapter could not read this bundle."); }
  const validation = validateAffiliateImportBundle(canonicalPayload);
  if (!validation.ok) throw new Error(validation.issues[0]?.message ?? "The uploaded bundle is invalid.");
  if (!adapterSupportsBundle(adapter, validation.bundle)) throw new Error("This adapter or bundle version is not supported.");
  const sourceMerchant = await db.merchant.findFirst({ where: { id: input.sourceMerchantId, ownerId: input.ownerId }, select: { id: true } });
  if (!sourceMerchant) throw new Error("Import source is not owned by this account.");
  const batch = await db.affiliateImportBatch.findFirst({ where: { id: input.batchId, merchantId: input.sourceMerchantId, ownerId: input.ownerId, sourceAdapter: input.adapterId }, select: { id: true, normalizedDigest: true, status: true, mappingChoices: true, applyProgress: true } });
  if (!batch || batch.normalizedDigest !== validation.digest) throw new Error("Upload the same bundle used for this preview.");
  if (batch.status === "COMPLETED") return report(batch.id, "COMPLETED", readProgress(batch.applyProgress));

  let choices: AffiliateImportApplyChoices;
  let effectiveAt: string;
  if (batch.status === "PREVIEW") {
    const submittedChoices = normalizeChoices(input.mappingChoices ?? {});
    const started = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string; mappingChoices: Prisma.JsonValue | null; completedAt: Date | null }[]>`
        SELECT "status", "mappingChoices", "completedAt" FROM "AffiliateImportBatch"
        WHERE "id" = ${batch.id} AND "ownerId" = ${input.ownerId}
        FOR UPDATE`;
      const current = locked[0];
      if (!current || current.status !== "PREVIEW" || current.completedAt !== null) throw new Error("The preview changed; reload the batch before confirming.");
      const savedChoices = normalizeChoices(current.mappingChoices ?? {});
      if (stableStringify(savedChoices) !== stableStringify(submittedChoices)) throw new Error("The mapping choices differ from the latest preview. Review the mappings again before confirming.");
      const at = new Date().toISOString();
      const choiceIssue = await validateChoices(input.ownerId, validation.bundle, savedChoices, new Date(at));
      if (choiceIssue) throw new Error(choiceIssue);
      await tx.affiliateImportBatch.update({ where: { id: batch.id }, data: {
        status: "APPLYING", applyProgress: {
          stage: "AFFILIATES", effectiveAt: at, cursor: 0, processed: { affiliates: 0, links: 0, commissions: 0, payouts: 0 },
          skipped: 0, merged: 0, conflicts: 0, unallocated: 0, totals: {}, skippedIds: [], mergedIds: [], conflictIds: [], unallocatedIds: [],
        } as Prisma.InputJsonValue,
      } });
      return { choices: savedChoices, effectiveAt: at };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    choices = started.choices;
    effectiveAt = started.effectiveAt;
  } else if (batch.status === "APPLYING" || batch.status === "FAILED") {
    choices = (batch.mappingChoices ?? {}) as AffiliateImportApplyChoices;
    effectiveAt = readProgress(batch.applyProgress).effectiveAt;
    if (input.mappingChoices && stableStringify(normalizeChoices(input.mappingChoices)) !== stableStringify(normalizeChoices(choices))) throw new Error("Mapping choices are fixed after import starts.");
    const choiceIssue = await validateChoices(input.ownerId, validation.bundle, choices, new Date(effectiveAt));
    if (choiceIssue) throw new Error(choiceIssue);
    if (batch.status === "FAILED") await db.affiliateImportBatch.updateMany({ where: { id: batch.id, ownerId: input.ownerId, status: "FAILED" }, data: { status: "APPLYING" } });
  } else throw new Error(`This batch cannot be applied from status ${batch.status}.`);

  let latest = report(batch.id, "APPLYING", readProgress(batch.applyProgress));
  const index = buildApplyIndex(validation.bundle, choices, new Date(effectiveAt));
  let chunks = 0;
  const maxChunks = Number.isInteger(input.maxChunks) && (input.maxChunks ?? 0) > 0 ? input.maxChunks! : 8;
  while (latest.status === "APPLYING" && chunks < maxChunks) {
    latest = await runChunk({ batchId: batch.id, ownerId: input.ownerId, sourceMerchantId: input.sourceMerchantId, bundle: validation.bundle, choices, adapter, index });
    chunks++;
  }
  return latest;
}

