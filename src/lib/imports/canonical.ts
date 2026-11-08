export const AFFILIATE_IMPORT_FORMAT = "affiliate-program" as const;
export const AFFILIATE_IMPORT_VERSION = 1 as const;

export type AffiliateIdentity = {
  sourceId: string;
  displayName?: string;
  email?: string;
  commissionRateBps?: number;
};

export type ReferralScope =
  { kind: "merchant" } | { kind: "product"; productSourceId: string };

export type ImportedReferralCode = {
  sourceId: string;
  affiliateSourceId: string;
  code: string;
  commissionRateOverrideBps?: number;
  scope: ReferralScope;
  status: "active" | "inactive";
  createdAt: string;
  activeFrom?: string;
  activeUntil?: string;
  legacyAliases?: string[];
};

export type ImportedCommissionStatus =
  "pending" | "payable" | "paid" | "voided" | "refunded" | "flagged";

export type ImportedCommissionRefund = {
  sourceId: string;
  occurredAt: string;
  amountMinor: string;
};

export type ImportedCommissionRow = {
  sourceId: string;
  affiliateSourceId: string;
  referralCodeSourceId?: string;
  sourceOrderId?: string;
  sourceTransactionId?: string;
  occurredAt: string;
  currency: string;
  amountMinor: string;
  refundedMinor: string;
  refunds?: ImportedCommissionRefund[];
  saleAmountMinor?: string;
  status: ImportedCommissionStatus;
};

export type ImportedPayoutSnapshot = {
  sourceId: string;
  affiliateSourceId: string;
  sourceCommissionIds: string[];
  periodStart: string;
  periodEnd: string;
  paidAt: string;
  currency: string;
  amountMinor: string;
  status: "paid" | "pending" | "voided";
};

export type AffiliateProgramImportBundle = {
  manifest: {
    format: typeof AFFILIATE_IMPORT_FORMAT;
    version: typeof AFFILIATE_IMPORT_VERSION;
    sourceAdapter: string;
    generatedAt: string;
  };
  affiliates: AffiliateIdentity[];
  referralCodes: ImportedReferralCode[];
  commissions: ImportedCommissionRow[];
  payouts: ImportedPayoutSnapshot[];
};

/** Stable JSON encoding used to digest the normalized in-memory bundle. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    "{" +
    keys
      .map((key) => JSON.stringify(key) + ":" + stableStringify(record[key]))
      .join(",") +
    "}"
  );
}
