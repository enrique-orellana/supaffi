"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getMerchantForOwnerBySlug } from "@/lib/merchant";
import {
  createAffiliateImportPreview,
  type AffiliateImportMappingChoices,
  type AffiliateImportPreview,
} from "@/lib/imports/preview";
import {
  applyAffiliateImportBatch,
  type AffiliateImportApplyChoices,
} from "@/lib/imports/apply";
import { MAX_IMPORT_UPLOAD_BYTES } from "@/lib/imports/validate";
import { requireAffiliateImportAdapter } from "@/lib/imports/adapters/registry";

type ActionError = { error: string };
type PreviewActionResult =
  | {
      preview: AffiliateImportPreview;
      adapterId: string;
      bundleInfo: {
        productSourceIds: string[];
        affiliates: {
          sourceId: string;
          email?: string;
          productSourceIds: string[];
          activeProductSourceIds: string[];
          hasMerchantScope: boolean;
        }[];
      };
    }
  | ActionError;

async function ownerId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner")
    throw new Error("Sign in as an Owner to manage imports.");
  return session.user.id;
}

async function ownedProduct(owner: string, slug: string) {
  const product = await getMerchantForOwnerBySlug(owner, slug);
  if (!product) throw new Error("Product not found.");
  return product;
}

async function uploadedJson(
  formData: FormData,
): Promise<{ file: File; value: unknown }> {
  const file = formData.get("bundle");
  if (!(file instanceof File) || file.size === 0)
    throw new Error("Choose a JSON bundle first.");
  if (file.size > MAX_IMPORT_UPLOAD_BYTES)
    throw new Error("The bundle exceeds the 8 MiB upload limit.");
  try {
    return { file, value: JSON.parse(await file.text()) as unknown };
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
}

function adapterForBundle(value: unknown) {
  const manifest =
    value && typeof value === "object"
      ? (value as { manifest?: { sourceAdapter?: unknown } }).manifest
      : undefined;
  if (!manifest || typeof manifest.sourceAdapter !== "string")
    throw new Error("The bundle manifest is missing its adapter ID.");
  return requireAffiliateImportAdapter(manifest.sourceAdapter);
}

export async function previewAffiliateImportAction(
  productSlug: string,
  formData: FormData,
): Promise<PreviewActionResult> {
  try {
    const owner = await ownerId();
    const product = await ownedProduct(owner, productSlug);
    const { value } = await uploadedJson(formData);
    const adapter = adapterForBundle(value);
    const canonicalBundle = (await adapter.toCanonicalBundle(value)) as {
      referralCodes?: {
        affiliateSourceId?: string;
        status?: string;
        activeFrom?: string;
        activeUntil?: string;
        scope?: { kind?: string; productSourceId?: string };
      }[];
      affiliates?: { sourceId?: string; email?: string }[];
    };
    const now = new Date();
    const [affiliates, referralCodes, products] = await Promise.all([
      db.affiliate.findMany({
        where: { merchant: { ownerId: owner } },
        select: {
          id: true,
          merchantId: true,
          programId: true,
          email: true,
          customCommissionRate: true,
        },
      }),
      db.affiliateLink.findMany({
        where: { affiliate: { merchant: { ownerId: owner } } },
        select: {
          merchantId: true,
          code: true,
          legacyAliases: true,
          commissionRateOverride: true,
        },
      }),
      db.merchant.findMany({
        where: { ownerId: owner },
        select: {
          id: true,
          trackingVerifiedAt: true,
          programs: { select: { id: true } },
        },
      }),
    ]);
    const retiredCodes = await db.retiredLinkCode.findMany({
      where: { merchantId: { in: products.map((merchant) => merchant.id) } },
      select: { merchantId: true, code: true },
    });
    let mappingChoices: AffiliateImportMappingChoices = {};
    const rawMappings = formData.get("mappingChoices");
    if (typeof rawMappings === "string" && rawMappings.trim()) {
      try {
        mappingChoices = JSON.parse(
          rawMappings,
        ) as AffiliateImportMappingChoices;
      } catch {
        return { error: "The selected mappings could not be read." };
      }
    }
    const result = await createAffiliateImportPreview({
      ownerId: owner,
      merchantId: product.id,
      adapter,
      uploadedBundle: value,
      adaptedBundle: canonicalBundle,
      mappingChoices,
      now,
      context: {
        affiliates: affiliates.map((affiliate) => ({
          id: affiliate.id,
          merchantId: affiliate.merchantId,
          programId: affiliate.programId,
          email: affiliate.email,
          commissionRateBps: affiliate.customCommissionRate
            ? Number(affiliate.customCommissionRate) * 100
            : null,
        })),
        referralCodes: referralCodes.map((link) => ({
          ...link,
          commissionRateOverrideBps: link.commissionRateOverride
            ? Number(link.commissionRateOverride) * 100
            : null,
        })),
        retiredCodes,
        products: products.map((merchant) => ({
          id: merchant.id,
          merchantId: merchant.id,
          trustworthy: merchant.trackingVerifiedAt !== null,
          programIds: merchant.programs.map((program) => program.id),
        })),
      },
    });
    if (!result.ok)
      return {
        error: result.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join(" "),
      };
    const bundle = canonicalBundle;
    const productSourceIds = [
      ...new Set(
        (bundle.referralCodes ?? []).flatMap((row) =>
          row.scope?.kind === "product" && row.scope.productSourceId
            ? [row.scope.productSourceId]
            : [],
        ),
      ),
    ];
    const linksByAffiliate = new Map<
      string,
      NonNullable<typeof bundle.referralCodes>
    >();
    for (const link of bundle.referralCodes ?? []) {
      if (!link.affiliateSourceId) continue;
      const rows = linksByAffiliate.get(link.affiliateSourceId) ?? [];
      rows.push(link);
      linksByAffiliate.set(link.affiliateSourceId, rows);
    }
    const sourceAffiliates = (bundle.affiliates ?? []).flatMap((row) => {
      if (typeof row.sourceId !== "string") return [];
      const links = linksByAffiliate.get(row.sourceId) ?? [];
      const activeLinks = links.filter(
        (link) =>
          link.status === "active" &&
          (!link.activeFrom || new Date(link.activeFrom) <= now) &&
          (!link.activeUntil || new Date(link.activeUntil) >= now),
      );
      return [
        {
          sourceId: row.sourceId,
          ...(typeof row.email === "string" ? { email: row.email } : {}),
          productSourceIds: [
            ...new Set(
              links.flatMap((code) =>
                code.scope?.kind === "product" && code.scope.productSourceId
                  ? [code.scope.productSourceId]
                  : [],
              ),
            ),
          ],
          activeProductSourceIds: [
            ...new Set(
              activeLinks.flatMap((code) =>
                code.scope?.kind === "product" && code.scope.productSourceId
                  ? [code.scope.productSourceId]
                  : [],
              ),
            ),
          ],
          hasMerchantScope: activeLinks.some(
            (code) => code.scope?.kind === "merchant",
          ),
        },
      ];
    });
    return {
      preview: result.preview,
      adapterId: adapter.id,
      bundleInfo: { productSourceIds, affiliates: sourceAffiliates },
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not prepare this import.",
    };
  }
}

export async function applyAffiliateImportAction(
  productSlug: string,
  formData: FormData,
) {
  try {
    const owner = await ownerId();
    const product = await ownedProduct(owner, productSlug);
    const { value } = await uploadedJson(formData);
    const batchId = String(formData.get("batchId") ?? "");
    const adapterId = String(formData.get("adapterId") ?? "");
    const adapter = requireAffiliateImportAdapter(adapterId);
    const rawMapping = String(formData.get("mappingChoices") ?? "{}");
    let mappingChoices: AffiliateImportApplyChoices;
    try {
      mappingChoices = JSON.parse(rawMapping) as AffiliateImportApplyChoices;
    } catch {
      throw new Error("The target selections could not be read.");
    }
    const report = await applyAffiliateImportBatch({
      ownerId: owner,
      sourceMerchantId: product.id,
      batchId,
      adapterId,
      adapter,
      uploadedBundle: value,
      mappingChoices,
      maxChunks: 8,
    });
    return { report };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Could not apply this import.",
    };
  }
}
