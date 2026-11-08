import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import type { AffiliateProgramImportBundle } from "@/lib/imports/canonical";
import type { AffiliateImportAdapter } from "@/lib/imports/adapters/types";
import { adapterSupportsBundle } from "@/lib/imports/adapters/types";
import { getAffiliateImportAdapter } from "@/lib/imports/adapters/registry";
import {
  importUploadSizeIssue,
  validateAffiliateImportBundle,
  type ImportValidationIssue,
} from "@/lib/imports/validate";

export type AffiliateImportMappingChoices = {
  affiliateTargets?: Record<string, Record<string, string>>;
  productTargets?: Record<string, { merchantId: string; programId: string }>;
  defaultTarget?: { merchantId: string; programId: string };
};

export type ImportPreviewContext = {
  affiliates: readonly {
    id: string;
    merchantId: string;
    programId: string;
    email: string | null;
    commissionRateBps: number | null;
  }[];
  referralCodes: readonly {
    merchantId: string;
    code: string;
    legacyAliases?: readonly string[];
    commissionRateOverrideBps?: number | null;
  }[];
  retiredCodes?: readonly { merchantId: string; code: string }[];
  products: readonly {
    id: string;
    merchantId: string;
    trustworthy: boolean;
    programIds: readonly string[];
  }[];
};

export type CurrencyTotals = {
  currency: string;
  grossMinor: string;
  refundedMinor: string;
  netMinor: string;
};
export type PayoutCurrencyTotals = { currency: string; totalMinor: string };
export type PreviewConflict = {
  sourceId: string;
  targetId?: string;
  reason: string;
};

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
    unmappable: {
      productSourceId: string;
      codeSourceIds: string[];
      reason: string;
    }[];
    unreliableTargets: { scopeLabel: string; targetProductId: string }[];
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

function isTargetPair(
  value: unknown,
): value is { merchantId: string; programId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("merchantId") &&
    keys.includes("programId") &&
    typeof (value as { merchantId?: unknown }).merchantId === "string" &&
    typeof (value as { programId?: unknown }).programId === "string"
  );
}

function safeMappingChoices(
  choices: AffiliateImportMappingChoices | undefined,
  bundle: AffiliateProgramImportBundle,
  context: ImportPreviewContext,
  now: Date,
): { stored: AffiliateImportMappingChoices; issues: ImportValidationIssue[] } {
  const issues: ImportValidationIssue[] = [];
  const stored: AffiliateImportMappingChoices = {
    affiliateTargets: {},
    productTargets: {},
  };
  const affiliateSources = new Set(
    bundle.affiliates.map((row) => row.sourceId),
  );
  const affiliatesBySource = new Map(
    bundle.affiliates.map((row) => [row.sourceId, row]),
  );
  const productSources = new Set(
    bundle.referralCodes.flatMap((row) =>
      row.scope.kind === "product" ? [row.scope.productSourceId] : [],
    ),
  );
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) {
    if (choices !== undefined)
      issues.push({
        path: "$.mappingChoices",
        message: "Mapping choices must be an object.",
      });
  } else {
    for (const key of Object.keys(choices)) {
      if (
        key !== "affiliateTargets" &&
        key !== "productTargets" &&
        key !== "defaultTarget"
      )
        issues.push({
          path: "$.mappingChoices." + key,
          message: "Mapping choice is not supported.",
        });
    }
  }
  if (
    choices &&
    choices.productTargets !== undefined &&
    (!choices.productTargets ||
      typeof choices.productTargets !== "object" ||
      Array.isArray(choices.productTargets))
  ) {
    issues.push({
      path: "$.mappingChoices.productTargets",
      message: "Product mappings must be an object.",
    });
  }
  if (
    choices &&
    choices.affiliateTargets !== undefined &&
    (!choices.affiliateTargets ||
      typeof choices.affiliateTargets !== "object" ||
      Array.isArray(choices.affiliateTargets))
  ) {
    issues.push({
      path: "$.mappingChoices.affiliateTargets",
      message: "Affiliate mappings must be an object.",
    });
  }
  if (
    choices &&
    issues.some(
      (issue) =>
        issue.path === "$.mappingChoices.productTargets" ||
        issue.path === "$.mappingChoices.affiliateTargets",
    )
  ) {
    return { stored, issues };
  }
  const productsById = new Map(context.products.map((row) => [row.id, row]));
  for (const [sourceId, target] of Object.entries(
    choices?.productTargets ?? {},
  )) {
    const path = "$.mappingChoices.productTargets." + sourceId;
    if (!SAFE_ID.test(sourceId) || !productSources.has(sourceId)) {
      issues.push({
        path,
        message:
          "Product mapping must name a source product and a valid Merchant+Program pair.",
      });
      continue;
    }
    if (!isTargetPair(target)) {
      issues.push({
        path,
        message:
          "A target must contain only merchantId and programId, both as strings.",
      });
      continue;
    }
    if (!SAFE_ID.test(target.merchantId) || !SAFE_ID.test(target.programId)) {
      issues.push({
        path,
        message:
          "Product mapping must name a source product and a valid Merchant+Program pair.",
      });
      continue;
    }
    const product = productsById.get(target.merchantId);
    if (!product || !product.programIds.includes(target.programId)) {
      issues.push({
        path,
        message: "Target Merchant and Program must belong to this Owner.",
      });
      continue;
    }
    stored.productTargets![sourceId] = {
      merchantId: target.merchantId,
      programId: target.programId,
    };
  }
  if (choices?.defaultTarget !== undefined) {
    const target = choices.defaultTarget;
    if (!isTargetPair(target)) {
      issues.push({
        path: "$.mappingChoices.defaultTarget",
        message:
          "A target must contain only merchantId and programId, both as strings.",
      });
    } else {
      const product = productsById.get(target.merchantId);
      if (
        !SAFE_ID.test(target.merchantId) ||
        !SAFE_ID.test(target.programId) ||
        !product ||
        !product.programIds.includes(target.programId)
      ) {
        issues.push({
          path: "$.mappingChoices.defaultTarget",
          message:
            "Merchant-wide target must be a Merchant+Program pair owned by this Owner.",
        });
      } else {
        stored.defaultTarget = {
          merchantId: target.merchantId,
          programId: target.programId,
        };
      }
    }
  }
  const targetsByAffiliate = new Map<
    string,
    Map<string, { merchantId: string; programId: string }>
  >();
  const programsByAffiliate = new Map<string, Map<string, Set<string>>>();
  for (const code of bundle.referralCodes) {
    if (
      code.status !== "active" ||
      (code.activeFrom && new Date(code.activeFrom) > now) ||
      (code.activeUntil && new Date(code.activeUntil) < now)
    )
      continue;
    const target =
      code.scope.kind === "merchant"
        ? stored.defaultTarget
        : stored.productTargets?.[code.scope.productSourceId];
    if (!target) continue;
    const byMerchant =
      targetsByAffiliate.get(code.affiliateSourceId) ??
      new Map<string, { merchantId: string; programId: string }>();
    byMerchant.set(target.merchantId, target);
    targetsByAffiliate.set(code.affiliateSourceId, byMerchant);
    const byProgram =
      programsByAffiliate.get(code.affiliateSourceId) ??
      new Map<string, Set<string>>();
    const ids = byProgram.get(target.merchantId) ?? new Set<string>();
    ids.add(target.programId);
    byProgram.set(target.merchantId, ids);
    programsByAffiliate.set(code.affiliateSourceId, byProgram);
  }
  const affiliatesById = new Map(
    context.affiliates.map((row) => [row.id, row]),
  );
  for (const [sourceId, byMerchant] of Object.entries(
    choices?.affiliateTargets ?? {},
  )) {
    const path = "$.mappingChoices.affiliateTargets." + sourceId;
    if (
      !byMerchant ||
      typeof byMerchant !== "object" ||
      Array.isArray(byMerchant)
    ) {
      issues.push({
        path,
        message: "Affiliate target choices must be grouped by Merchant.",
      });
      continue;
    }
    const source = affiliatesBySource.get(sourceId);
    if (
      !SAFE_ID.test(sourceId) ||
      !affiliateSources.has(sourceId) ||
      !source?.email
    ) {
      issues.push({
        path,
        message: "Affiliate mapping needs a source identity with an email.",
      });
      continue;
    }
    for (const [merchantId, affiliateId] of Object.entries(byMerchant)) {
      const target = targetsByAffiliate.get(sourceId)?.get(merchantId);
      const affiliate = affiliatesById.get(affiliateId);
      if (
        !SAFE_ID.test(merchantId) ||
        !SAFE_ID.test(affiliateId) ||
        !target ||
        affiliate?.merchantId !== merchantId ||
        affiliate.programId !== target.programId ||
        affiliate.email?.trim().toLowerCase() !==
          source.email.trim().toLowerCase()
      ) {
        issues.push({
          path: path + "." + merchantId,
          message:
            "Choose an existing affiliate with the same normalized email in the mapped Merchant and Program.",
        });
        continue;
      }
      stored.affiliateTargets![sourceId] = {
        ...(stored.affiliateTargets?.[sourceId] ?? {}),
        [merchantId]: affiliateId,
      };
    }
  }
  return { stored, issues };
}

function aggregateCommissions(
  bundle: AffiliateProgramImportBundle,
): CurrencyTotals[] {
  const totals = new Map<string, { gross: bigint; refunded: bigint }>();
  for (const row of bundle.commissions) {
    const total = totals.get(row.currency) ?? { gross: 0n, refunded: 0n };
    total.gross += BigInt(row.amountMinor);
    total.refunded += BigInt(row.refundedMinor);
    totals.set(row.currency, total);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, value]) => ({
      currency,
      grossMinor: value.gross.toString(),
      refundedMinor: value.refunded.toString(),
      netMinor: (value.gross - value.refunded).toString(),
    }));
}

function aggregatePayouts(
  bundle: AffiliateProgramImportBundle,
): PayoutCurrencyTotals[] {
  const totals = new Map<string, bigint>();
  for (const row of bundle.payouts)
    totals.set(
      row.currency,
      (totals.get(row.currency) ?? 0n) + BigInt(row.amountMinor),
    );
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => ({ currency, totalMinor: total.toString() }));
}

function buildPreview(
  bundle: AffiliateProgramImportBundle,
  context: ImportPreviewContext,
  mappings: AffiliateImportMappingChoices,
  now: Date,
): Omit<AffiliateImportPreview, "batchId" | "digest"> {
  const rate: PreviewConflict[] = [];
  const identity: PreviewConflict[] = [];
  const code: PreviewConflict[] = [];
  const nowIso = now.toISOString();
  const nowCanonical =
    nowIso.slice(0, 19) + "." + nowIso.slice(20, 23).padEnd(9, "0") + "Z";
  const active = (row: AffiliateProgramImportBundle["referralCodes"][number]) =>
    row.status === "active" &&
    (!row.activeFrom || row.activeFrom <= nowCanonical) &&
    (!row.activeUntil || row.activeUntil >= nowCanonical);
  const productsById = new Map(context.products.map((row) => [row.id, row]));
  const affiliatesById = new Map(
    context.affiliates.map((row) => [row.id, row]),
  );
  const affiliatesByMerchantEmail = new Map<
    string,
    (typeof context.affiliates)[number][]
  >();
  for (const affiliate of context.affiliates) {
    const email = affiliate.email?.trim().toLowerCase();
    if (!email) continue;
    const key = `${affiliate.merchantId}:${email}`;
    const values = affiliatesByMerchantEmail.get(key) ?? [];
    values.push(affiliate);
    affiliatesByMerchantEmail.set(key, values);
  }
  const existingCodesByMerchant = new Map<
    string,
    Map<string, (typeof context.referralCodes)[number] | null>
  >();
  for (const row of context.referralCodes) {
    const values =
      existingCodesByMerchant.get(row.merchantId) ??
      new Map<string, (typeof context.referralCodes)[number] | null>();
    values.set(row.code.toLowerCase(), row);
    for (const alias of row.legacyAliases ?? [])
      values.set(alias.toLowerCase(), row);
    existingCodesByMerchant.set(row.merchantId, values);
  }
  const retiredByMerchant = new Map<string, Set<string>>();
  for (const row of context.retiredCodes ?? []) {
    const values = retiredByMerchant.get(row.merchantId) ?? new Set<string>();
    values.add(row.code.toLowerCase());
    retiredByMerchant.set(row.merchantId, values);
  }
  const targetsByAffiliate = new Map<string, Map<string, Set<string>>>();
  const productGroups = new Map<string, string[]>();
  for (const link of bundle.referralCodes) {
    if (link.scope.kind === "product") {
      const group = productGroups.get(link.scope.productSourceId) ?? [];
      group.push(link.sourceId);
      productGroups.set(link.scope.productSourceId, group);
    }
    if (!active(link)) continue;
    const target =
      link.scope.kind === "merchant"
        ? mappings.defaultTarget
        : mappings.productTargets?.[link.scope.productSourceId];
    if (!target) continue;
    const byMerchant =
      targetsByAffiliate.get(link.affiliateSourceId) ??
      new Map<string, Set<string>>();
    const programIds = byMerchant.get(target.merchantId) ?? new Set<string>();
    programIds.add(target.programId);
    byMerchant.set(target.merchantId, programIds);
    targetsByAffiliate.set(link.affiliateSourceId, byMerchant);
  }

  for (const source of bundle.affiliates) {
    for (const [merchantId, programIds] of targetsByAffiliate.get(
      source.sourceId,
    ) ?? []) {
      const targetId =
        mappings.affiliateTargets?.[source.sourceId]?.[merchantId];
      if (targetId) {
        const target = affiliatesById.get(targetId);
        if (
          source.commissionRateBps !== undefined &&
          target?.commissionRateBps !== null &&
          target?.commissionRateBps !== undefined &&
          source.commissionRateBps !== target.commissionRateBps
        ) {
          rate.push({
            sourceId: source.sourceId,
            targetId,
            reason: "rate_mismatch",
          });
        }
      } else if (source.email) {
        const matches =
          affiliatesByMerchantEmail.get(
            `${merchantId}:${source.email.trim().toLowerCase()}`,
          ) ?? [];
        for (const match of matches)
          identity.push({
            sourceId: source.sourceId,
            targetId: match.id,
            reason: "email_requires_mapping",
          });
      }
      if (programIds.size !== 1)
        identity.push({
          sourceId: source.sourceId,
          reason: "multiple_program_targets",
        });
    }
  }

  for (const imported of bundle.referralCodes) {
    const target =
      imported.scope.kind === "merchant"
        ? mappings.defaultTarget
        : mappings.productTargets?.[imported.scope.productSourceId];
    if (!target) continue;
    const existing = existingCodesByMerchant.get(target.merchantId);
    const retired = retiredByMerchant.get(target.merchantId);
    const names = [
      imported.code.toLowerCase(),
      ...(imported.legacyAliases ?? []).map((alias) => alias.toLowerCase()),
    ];
    const conflictingName = names.find(
      (name) => existing?.has(name) || retired?.has(name),
    );
    if (conflictingName) {
      code.push({
        sourceId: imported.sourceId,
        targetId: target.merchantId,
        reason: "code_or_alias_already_exists",
      });
      const existingRow = existing?.get(imported.code.toLowerCase());
      if (
        existingRow &&
        imported.commissionRateOverrideBps !== undefined &&
        existingRow.commissionRateOverrideBps !==
          imported.commissionRateOverrideBps
      ) {
        rate.push({
          sourceId: imported.sourceId,
          targetId: existingRow.code,
          reason: "link_rate_mismatch",
        });
      }
    }
  }

  const unmappable: AffiliateImportPreview["productScopes"]["unmappable"] = [];
  const unreliableTargets: AffiliateImportPreview["productScopes"]["unreliableTargets"] =
    [];
  for (const [productSourceId, codeSourceIds] of productGroups) {
    const mapping = mappings.productTargets?.[productSourceId];
    const target = mapping ? productsById.get(mapping.merchantId) : undefined;
    if (!mapping)
      unmappable.push({
        productSourceId,
        codeSourceIds,
        reason: "mapping_required",
      });
    else if (!target || !target.programIds.includes(mapping.programId))
      unmappable.push({
        productSourceId,
        codeSourceIds,
        reason: "target_missing_or_out_of_scope",
      });
    else if (!target.trustworthy) {
      unmappable.push({
        productSourceId,
        codeSourceIds,
        reason: "target_untrustworthy",
      });
      unreliableTargets.push({
        scopeLabel: `Product ${productSourceId}`,
        targetProductId: target.id,
      });
    }
  }
  const merchantWideCodes = bundle.referralCodes.filter(
    (code) => code.scope.kind === "merchant",
  );
  if (merchantWideCodes.length && mappings.defaultTarget) {
    const target = productsById.get(mappings.defaultTarget.merchantId);
    if (
      !target ||
      !target.programIds.includes(mappings.defaultTarget.programId)
    ) {
      unmappable.push({
        productSourceId: "Merchant-wide",
        codeSourceIds: merchantWideCodes.map((code) => code.sourceId),
        reason: "target_missing_or_out_of_scope",
      });
    } else if (!target.trustworthy) {
      unreliableTargets.push({
        scopeLabel: "Merchant-wide",
        targetProductId: target.id,
      });
    }
  }
  const activeLinks = bundle.referralCodes.filter(active).length;

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

function toStoredTotals(
  preview: Omit<AffiliateImportPreview, "batchId" | "digest">,
): Record<string, unknown> {
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
  ownerId: string;
  merchantId: string;
  sourceAdapter: string;
  sourceFormatVersion: number;
  normalizedDigest: string;
  mappingChoices: Prisma.InputJsonValue;
  previewTotals: Prisma.InputJsonValue;
}): Promise<
  { kind: "saved"; batchId: string } | { kind: "blocked"; status: string }
> {
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
    const ownerScoped = await db.affiliateImportBatch.findFirst({
      where: { id: existing.id, ownerId: input.ownerId },
      select: { id: true },
    });
    if (!ownerScoped) return { kind: "blocked", status: "OWNER_MISMATCH" };
    if (existing.status !== "PREVIEW" || existing.completedAt !== null) {
      return {
        kind: "blocked",
        status: existing.status === "PREVIEW" ? "COMPLETED" : existing.status,
      };
    }
    const updated = await db.affiliateImportBatch.updateMany({
      where: { id: existing.id, status: "PREVIEW", completedAt: null },
      data: updateData,
    });
    if (updated.count === 1) return { kind: "saved", batchId: existing.id };
    const current = await db.affiliateImportBatch.findUnique({
      where: { id: existing.id },
      select: { status: true, completedAt: true },
    });
    return {
      kind: "blocked",
      status:
        current?.status === "PREVIEW" && current.completedAt !== null
          ? "COMPLETED"
          : (current?.status ?? "CHANGED"),
    };
  }

  try {
    const created = await db.affiliateImportBatch.create({
      data: {
        merchantId: input.merchantId,
        ownerId: input.ownerId,
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
      return {
        kind: "blocked",
        status: raced.status === "PREVIEW" ? "COMPLETED" : raced.status,
      };
    }
    const updated = await db.affiliateImportBatch.updateMany({
      where: { id: raced.id, status: "PREVIEW", completedAt: null },
      data: updateData,
    });
    if (updated.count === 1) return { kind: "saved", batchId: raced.id };
    const current = await db.affiliateImportBatch.findUnique({
      where: { id: raced.id },
      select: { status: true, completedAt: true },
    });
    return {
      kind: "blocked",
      status:
        current?.status === "PREVIEW" && current.completedAt !== null
          ? "COMPLETED"
          : (current?.status ?? "CHANGED"),
    };
  }
}
export async function createAffiliateImportPreview(input: {
  ownerId: string;
  merchantId: string;
  adapter: AffiliateImportAdapter;
  uploadedBundle: unknown;
  adaptedBundle?: unknown;
  mappingChoices?: AffiliateImportMappingChoices;
  context: ImportPreviewContext;
  now?: Date;
}): Promise<AffiliateImportPreviewResult> {
  const uploadIssue = importUploadSizeIssue(input.uploadedBundle);
  if (uploadIssue) return { ok: false, issues: [uploadIssue] };
  const adapter = getAffiliateImportAdapter(input.adapter.id);
  if (!adapter || adapter !== input.adapter)
    return {
      ok: false,
      issues: [
        {
          path: "$.manifest.sourceAdapter",
          message: "This adapter is not registered on the server.",
        },
      ],
    };
  const adapted =
    input.adaptedBundle ??
    (await adapter.toCanonicalBundle(input.uploadedBundle));
  const validated = validateAffiliateImportBundle(adapted);
  if (!validated.ok) return validated;
  if (!adapterSupportsBundle(adapter, validated.bundle)) {
    return {
      ok: false,
      issues: [
        {
          path: "$.manifest",
          message: "Bundle adapter or version is not supported.",
        },
      ],
    };
  }
  if (!SAFE_ID.test(input.merchantId)) {
    return {
      ok: false,
      issues: [
        { path: "$.merchantId", message: "Preview Merchant scope is invalid." },
      ],
    };
  }
  const ownedMerchant = await db.merchant.findFirst({
    where: { id: input.merchantId, ownerId: input.ownerId },
    select: { id: true },
  });
  if (!ownedMerchant)
    return {
      ok: false,
      issues: [
        {
          path: "$.merchantId",
          message: "Preview Merchant scope is not owned by this account.",
        },
      ],
    };
  const now = input.now ?? new Date();
  const mappingResult = safeMappingChoices(
    input.mappingChoices,
    validated.bundle,
    input.context,
    now,
  );
  if (mappingResult.issues.length)
    return { ok: false, issues: mappingResult.issues };

  const summary = buildPreview(
    validated.bundle,
    input.context,
    mappingResult.stored,
    now,
  );
  const safeMappings = mappingResult.stored as Prisma.InputJsonValue;
  const safeTotals = toStoredTotals(summary) as Prisma.InputJsonValue;
  const saved = await savePreviewBatch({
    ownerId: input.ownerId,
    merchantId: input.merchantId,
    sourceAdapter: adapter.id,
    sourceFormatVersion: validated.bundle.manifest.version,
    normalizedDigest: validated.digest,
    mappingChoices: safeMappings,
    previewTotals: safeTotals,
  });
  if (saved.kind === "blocked") {
    const message =
      saved.status === "COMPLETED"
        ? "A batch for this digest is already completed; its report is read-only."
        : "A batch for this digest is in status " +
          saved.status +
          " and cannot be previewed.";
    return { ok: false, issues: [{ path: "$.manifest", message }] };
  }

  return {
    ok: true,
    preview: { batchId: saved.batchId, digest: validated.digest, ...summary },
  };
}
