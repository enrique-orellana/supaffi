import { createHash } from "node:crypto";
import {
  AFFILIATE_IMPORT_FORMAT,
  AFFILIATE_IMPORT_VERSION,
  stableStringify,
  type AffiliateIdentity,
  type AffiliateProgramImportBundle,
  type ImportedCommissionRow,
  type ImportedCommissionRefund,
  type ImportedPayoutSnapshot,
  type ImportedReferralCode,
} from "@/lib/imports/canonical";

export const MAX_IMPORT_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_ROWS_PER_SECTION = 50_000;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ADAPTER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

export type ImportValidationIssue = { path: string; message: string };
export type AffiliateImportValidation =
  | { ok: true; bundle: AffiliateProgramImportBundle; normalizedJson: string; digest: string }
  | { ok: false; issues: ImportValidationIssue[] };

function compareStableStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ImportValidationIssue[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) issues.push({ path: path + "." + key, message: "Field is not allowed in this format." });
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ImportValidationIssue[],
  min: number,
  max: number,
  pattern?: RegExp,
): string | null {
  const raw = value[key];
  if (typeof raw !== "string") {
    issues.push({ path: path + "." + key, message: "Expected a string." });
    return null;
  }
  const normalized = raw.trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    issues.push({ path: path + "." + key, message: "String length or characters are invalid." });
    return null;
  }
  if (pattern && !pattern.test(normalized)) {
    issues.push({ path: path + "." + key, message: "Identifier format is invalid." });
    return null;
  }
  return normalized;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ImportValidationIssue[],
  max: number,
  pattern?: RegExp,
): string | undefined | null {
  if (value[key] === undefined) return undefined;
  const normalized = requiredString(value, key, path, issues, 1, max, pattern);
  return normalized ?? null;
}

function isoTimestamp(value: string, path: string, issues: ImportValidationIssue[]): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) {
    issues.push({ path, message: "Expected an ISO 8601 timestamp with a timezone." });
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    month < 1 || month > 12 || day < 1 ||
    local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    issues.push({ path, message: "Timestamp is not a valid calendar date or time." });
    return null;
  }
  const offsetDirection = match[9] === "+" ? 1 : match[9] === "-" ? -1 : 0;
  const offsetMillis = offsetDirection * (offsetHour * 60 + offsetMinute) * 60_000;
  const utc = new Date(local.getTime() - offsetMillis);
  if (!Number.isFinite(utc.getTime()) || utc.getUTCFullYear() < 0 || utc.getUTCFullYear() > 9999) {
    issues.push({ path, message: "Timestamp is outside the supported range." });
    return null;
  }
  const fraction = (match[7] ?? "").replace(/0+$/, "").padEnd(9, "0");
  return utc.toISOString().slice(0, 19) + "." + fraction + "Z";
}

function optionalTimestamp(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ImportValidationIssue[],
): string | undefined | null {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "string") {
    issues.push({ path: path + "." + key, message: "Expected an ISO 8601 timestamp." });
    return null;
  }
  return isoTimestamp(value[key] as string, path + "." + key, issues);
}

function currency(value: Record<string, unknown>, key: string, path: string, issues: ImportValidationIssue[]): string | null {
  const code = requiredString(value, key, path, issues, 3, 3);
  if (!code) return null;
  const normalized = code.toUpperCase();
  if (!CURRENCY_CODES.has(normalized)) {
    issues.push({ path: path + "." + key, message: "Currency must be a supported ISO 4217 code." });
    return null;
  }
  return normalized;
}

function minorAmount(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ImportValidationIssue[],
  allowZero: boolean,
): string | null {
  const amount = requiredString(value, key, path, issues, 1, 18);
  if (!amount || !/^(0|[1-9]\d{0,17})$/.test(amount)) {
    if (amount) issues.push({ path: path + "." + key, message: "Amount must be a non-negative integer in minor units." });
    return null;
  }
  if (!allowZero && BigInt(amount) === 0n) {
    issues.push({ path: path + "." + key, message: "Amount must be greater than zero." });
    return null;
  }
  return amount;
}

function stringArray(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ImportValidationIssue[],
  pattern: RegExp,
): string[] | null {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.length > MAX_ROWS_PER_SECTION) {
    issues.push({ path: path + "." + key, message: "Expected a bounded array of strings." });
    return null;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== "string" || !pattern.test(entry.trim())) {
      issues.push({ path: path + "." + key + "[" + index + "]", message: "Value format is invalid." });
      return;
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) issues.push({ path: path + "." + key + "[" + index + "]", message: "Duplicate value." });
    seen.add(normalized);
    result.push(normalized);
  });
  return result.sort((a, b) => compareStableStrings(a, b));
}

function rows(value: Record<string, unknown>, key: string, issues: ImportValidationIssue[]): unknown[] {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.length > MAX_ROWS_PER_SECTION) {
    issues.push({ path: "$." + key, message: "Expected a bounded array." });
    return [];
  }
  return raw;
}

function duplicateIssues<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  path: string,
  issues: ImportValidationIssue[],
): void {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const id = idOf(row);
    if (seen.has(id)) issues.push({ path: path + "[" + index + "].sourceId", message: "Duplicate source ID." });
    seen.add(id);
  });
}

function validateAffiliateRow(value: unknown, index: number, issues: ImportValidationIssue[]): AffiliateIdentity | null {
  const path = "$.affiliates[" + index + "]";
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return null;
  }
  checkKeys(value, ["sourceId", "displayName", "email", "commissionRateBps"], path, issues);
  const sourceId = requiredString(value, "sourceId", path, issues, 1, 160, SOURCE_ID_PATTERN);
  const displayName = optionalString(value, "displayName", path, issues, 200);
  const emailValue = optionalString(value, "email", path, issues, 254);
  const email = typeof emailValue === "string" ? emailValue.toLowerCase() : undefined;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    issues.push({ path: path + ".email", message: "Affiliate contact email is invalid." });
  }
  let commissionRateBps: number | undefined;
  if (value.commissionRateBps !== undefined) {
    const rate = value.commissionRateBps;
    if (!Number.isInteger(rate) || (rate as number) < 0 || (rate as number) > 10_000) {
      issues.push({ path: path + ".commissionRateBps", message: "Rate must be an integer from 0 to 10000 basis points." });
    } else commissionRateBps = rate as number;
  }
  if (!sourceId || displayName === null || emailValue === null) return null;
  return {
    sourceId,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(commissionRateBps !== undefined ? { commissionRateBps } : {}),
  };
}

function validateReferralRow(value: unknown, index: number, issues: ImportValidationIssue[]): ImportedReferralCode | null {
  const path = "$.referralCodes[" + index + "]";
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return null;
  }
  checkKeys(value, ["sourceId", "affiliateSourceId", "code", "commissionRateOverrideBps", "scope", "status", "createdAt", "activeFrom", "activeUntil", "legacyAliases"], path, issues);
  const sourceId = requiredString(value, "sourceId", path, issues, 1, 160, SOURCE_ID_PATTERN);
  const affiliateSourceId = requiredString(value, "affiliateSourceId", path, issues, 1, 160, SOURCE_ID_PATTERN);
  const codeValue = requiredString(value, "code", path, issues, 1, 100, CODE_PATTERN);
  const code = codeValue?.toLowerCase() ?? null;
  let commissionRateOverrideBps: number | undefined;
  if (value.commissionRateOverrideBps !== undefined) {
    const rate = value.commissionRateOverrideBps;
    if (!Number.isInteger(rate) || (rate as number) < 0 || (rate as number) > 10_000) {
      issues.push({ path: path + ".commissionRateOverrideBps", message: "Rate must be an integer from 0 to 10000 basis points." });
    } else commissionRateOverrideBps = rate as number;
  }
  const status = value.status;
  if (status !== "active" && status !== "inactive") issues.push({ path: path + ".status", message: "Status must be active or inactive." });
  const createdAtRaw = requiredString(value, "createdAt", path, issues, 1, 40);
  const createdAt = createdAtRaw ? isoTimestamp(createdAtRaw, path + ".createdAt", issues) : null;
  const activeFrom = optionalTimestamp(value, "activeFrom", path, issues);
  const activeUntil = optionalTimestamp(value, "activeUntil", path, issues);
  const scopeValue = value.scope;
  let scope: ImportedReferralCode["scope"] | null = null;
  if (!isRecord(scopeValue)) {
    issues.push({ path: path + ".scope", message: "Expected a scope object." });
  } else if (scopeValue.kind === "merchant") {
    checkKeys(scopeValue, ["kind"], path + ".scope", issues);
    scope = { kind: "merchant" };
  } else if (scopeValue.kind === "product") {
    checkKeys(scopeValue, ["kind", "productSourceId"], path + ".scope", issues);
    const productSourceId = requiredString(scopeValue, "productSourceId", path + ".scope", issues, 1, 160, SOURCE_ID_PATTERN);
    if (productSourceId) scope = { kind: "product", productSourceId };
  } else issues.push({ path: path + ".scope.kind", message: "Scope kind must be merchant or product." });
  let legacyAliases: string[] | undefined;
  if (value.legacyAliases !== undefined) {
    const aliases = stringArray(value, "legacyAliases", path, issues, CODE_PATTERN);
    if (aliases) legacyAliases = aliases.map((alias) => alias.toLowerCase()).sort(compareStableStrings);
  }
  if (activeFrom && activeUntil && activeFrom > activeUntil) {
    issues.push({ path, message: "activeFrom must be earlier than or equal to activeUntil." });
  }
  if (!sourceId || !affiliateSourceId || !code || !createdAt || !scope || (status !== "active" && status !== "inactive") || activeFrom === null || activeUntil === null) return null;
  return {
    sourceId,
    affiliateSourceId,
    code,
    ...(commissionRateOverrideBps !== undefined ? { commissionRateOverrideBps } : {}),
    scope,
    status,
    createdAt,
    ...(activeFrom !== undefined ? { activeFrom } : {}),
    ...(activeUntil !== undefined ? { activeUntil } : {}),
    ...(legacyAliases !== undefined ? { legacyAliases } : {}),
  };
}

function validateCommissionRow(value: unknown, index: number, issues: ImportValidationIssue[]): ImportedCommissionRow | null {
  const path = "$.commissions[" + index + "]";
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return null;
  }
  checkKeys(value, ["sourceId", "affiliateSourceId", "referralCodeSourceId", "sourceOrderId", "sourceTransactionId", "occurredAt", "currency", "amountMinor", "refundedMinor", "refunds", "saleAmountMinor", "status"], path, issues);
  const sourceId = requiredString(value, "sourceId", path, issues, 1, 160, SOURCE_ID_PATTERN);
  const affiliateSourceId = requiredString(value, "affiliateSourceId", path, issues, 1, 160, SOURCE_ID_PATTERN);
  const referralCodeSourceId = optionalString(value, "referralCodeSourceId", path, issues, 160, SOURCE_ID_PATTERN);
  const sourceOrderId = optionalString(value, "sourceOrderId", path, issues, 160, SOURCE_ID_PATTERN);
  const sourceTransactionId = optionalString(value, "sourceTransactionId", path, issues, 160, SOURCE_ID_PATTERN);
  const occurredAtRaw = requiredString(value, "occurredAt", path, issues, 1, 40);
  const occurredAt = occurredAtRaw ? isoTimestamp(occurredAtRaw, path + ".occurredAt", issues) : null;
  const code = currency(value, "currency", path, issues);
  const amountMinor = minorAmount(value, "amountMinor", path, issues, false);
  const refundedMinor = minorAmount(value, "refundedMinor", path, issues, true);
  let refunds: ImportedCommissionRefund[] | undefined;
  if (value.refunds !== undefined) {
    if (!Array.isArray(value.refunds) || value.refunds.length > MAX_ROWS_PER_SECTION) {
      issues.push({ path: path + ".refunds", message: "Expected a bounded array of refund rows." });
    } else {
      const seenRefundIds = new Set<string>();
      refunds = value.refunds.map((refundValue, refundIndex) => {
        const refundPath = path + ".refunds[" + refundIndex + "]";
        if (!isRecord(refundValue)) {
          issues.push({ path: refundPath, message: "Expected an object." });
          return null;
        }
        checkKeys(refundValue, ["sourceId", "occurredAt", "amountMinor"], refundPath, issues);
        const refundId = requiredString(refundValue, "sourceId", refundPath, issues, 1, 160, SOURCE_ID_PATTERN);
        const refundTimeRaw = requiredString(refundValue, "occurredAt", refundPath, issues, 1, 40);
        const refundTime = refundTimeRaw ? isoTimestamp(refundTimeRaw, refundPath + ".occurredAt", issues) : null;
        const refundAmount = minorAmount(refundValue, "amountMinor", refundPath, issues, false);
        if (refundId && seenRefundIds.has(refundId)) issues.push({ path: refundPath + ".sourceId", message: "Duplicate refund source ID." });
        if (refundId) seenRefundIds.add(refundId);
        return refundId && refundTime && refundAmount ? { sourceId: refundId, occurredAt: refundTime, amountMinor: refundAmount } : null;
      }).filter((refund): refund is ImportedCommissionRefund => refund !== null).sort((a, b) => compareStableStrings(a.sourceId, b.sourceId));
    }
  }
  const saleAmountMinor = value.saleAmountMinor === undefined ? undefined : minorAmount(value, "saleAmountMinor", path, issues, false);
  const status = value.status;
  const allowedStatus = ["pending", "payable", "paid", "voided", "refunded", "flagged"];
  if (typeof status !== "string" || !allowedStatus.includes(status)) issues.push({ path: path + ".status", message: "Commission status is invalid." });
  if (amountMinor && refundedMinor && BigInt(refundedMinor) > BigInt(amountMinor)) {
    issues.push({ path: path + ".refundedMinor", message: "Refund cannot exceed the commission amount." });
  }
  if (refunds && refunds.reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n) !== BigInt(refundedMinor ?? "0")) {
    issues.push({ path: path + ".refunds", message: "Refund rows must sum to refundedMinor." });
  }
  if (!sourceId || !affiliateSourceId || !occurredAt || !code || !amountMinor || refundedMinor === null || (saleAmountMinor === null) || typeof status !== "string" || !allowedStatus.includes(status)) return null;
  return {
    sourceId,
    affiliateSourceId,
    ...(referralCodeSourceId ? { referralCodeSourceId } : {}),
    ...(sourceOrderId ? { sourceOrderId } : {}),
    ...(sourceTransactionId ? { sourceTransactionId } : {}),
    occurredAt,
    currency: code,
    amountMinor,
    refundedMinor,
    ...(refunds !== undefined ? { refunds } : {}),
    ...(saleAmountMinor ? { saleAmountMinor } : {}),
    status: status as ImportedCommissionRow["status"],
  };
}

function validatePayoutRow(value: unknown, index: number, issues: ImportValidationIssue[]): ImportedPayoutSnapshot | null {
  const path = "$.payouts[" + index + "]";
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return null;
  }
  checkKeys(value, ["sourceId", "affiliateSourceId", "sourceCommissionIds", "periodStart", "periodEnd", "paidAt", "currency", "amountMinor", "status"], path, issues);
  const sourceId = requiredString(value, "sourceId", path, issues, 1, 160, SOURCE_ID_PATTERN);
  const affiliateSourceId = requiredString(value, "affiliateSourceId", path, issues, 1, 160, SOURCE_ID_PATTERN);
  const sourceCommissionIds = stringArray(value, "sourceCommissionIds", path, issues, SOURCE_ID_PATTERN);
  const periodStartRaw = requiredString(value, "periodStart", path, issues, 1, 40);
  const periodEndRaw = requiredString(value, "periodEnd", path, issues, 1, 40);
  const paidAtRaw = requiredString(value, "paidAt", path, issues, 1, 40);
  const periodStart = periodStartRaw ? isoTimestamp(periodStartRaw, path + ".periodStart", issues) : null;
  const periodEnd = periodEndRaw ? isoTimestamp(periodEndRaw, path + ".periodEnd", issues) : null;
  const paidAt = paidAtRaw ? isoTimestamp(paidAtRaw, path + ".paidAt", issues) : null;
  const code = currency(value, "currency", path, issues);
  const amountMinor = minorAmount(value, "amountMinor", path, issues, false);
  const status = value.status;
  if (status !== "paid" && status !== "pending" && status !== "voided") issues.push({ path: path + ".status", message: "Payout status is invalid." });
  if (periodStart && periodEnd && periodStart > periodEnd) issues.push({ path, message: "periodStart must be earlier than or equal to periodEnd." });
  if (!sourceId || !affiliateSourceId || !sourceCommissionIds || !periodStart || !periodEnd || !paidAt || !code || !amountMinor || (status !== "paid" && status !== "pending" && status !== "voided")) return null;
  return { sourceId, affiliateSourceId, sourceCommissionIds, periodStart, periodEnd, paidAt, currency: code, amountMinor, status };
}

function validatePayload(input: unknown): AffiliateImportValidation {
  const issues: ImportValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "Expected a JSON object." }] };
  checkKeys(input, ["manifest", "affiliates", "referralCodes", "commissions", "payouts"], "$", issues);
  const manifestValue = input.manifest;
  let manifest: AffiliateProgramImportBundle["manifest"] | null = null;
  if (!isRecord(manifestValue)) {
    issues.push({ path: "$.manifest", message: "Expected a manifest object." });
  } else {
    checkKeys(manifestValue, ["format", "version", "sourceAdapter", "generatedAt"], "$.manifest", issues);
    if (manifestValue.format !== AFFILIATE_IMPORT_FORMAT) issues.push({ path: "$.manifest.format", message: "Unsupported bundle format." });
    if (manifestValue.version !== AFFILIATE_IMPORT_VERSION) issues.push({ path: "$.manifest.version", message: "Unsupported bundle version." });
    const sourceAdapter = requiredString(manifestValue, "sourceAdapter", "$.manifest", issues, 1, 64, ADAPTER_PATTERN);
    const generatedAtRaw = requiredString(manifestValue, "generatedAt", "$.manifest", issues, 1, 40);
    const generatedAt = generatedAtRaw ? isoTimestamp(generatedAtRaw, "$.manifest.generatedAt", issues) : null;
    if (manifestValue.version !== undefined && !Number.isInteger(manifestValue.version)) issues.push({ path: "$.manifest.version", message: "Version must be an integer." });
    if (sourceAdapter && generatedAt && manifestValue.format === AFFILIATE_IMPORT_FORMAT && manifestValue.version === AFFILIATE_IMPORT_VERSION) {
      manifest = { format: AFFILIATE_IMPORT_FORMAT, version: AFFILIATE_IMPORT_VERSION, sourceAdapter, generatedAt };
    }
  }

  const affiliates = rows(input, "affiliates", issues).map((row, index) => validateAffiliateRow(row, index, issues)).filter((row): row is AffiliateIdentity => row !== null);
  const referralCodes = rows(input, "referralCodes", issues).map((row, index) => validateReferralRow(row, index, issues)).filter((row): row is ImportedReferralCode => row !== null);
  const commissions = rows(input, "commissions", issues).map((row, index) => validateCommissionRow(row, index, issues)).filter((row): row is ImportedCommissionRow => row !== null);
  const payouts = rows(input, "payouts", issues).map((row, index) => validatePayoutRow(row, index, issues)).filter((row): row is ImportedPayoutSnapshot => row !== null);

  const refundIds = new Set<string>();
  commissions.forEach((row, index) => row.refunds?.forEach((refund, refundIndex) => {
    if (refundIds.has(refund.sourceId)) issues.push({ path: "$.commissions[" + index + "].refunds[" + refundIndex + "].sourceId", message: "Duplicate refund source ID." });
    refundIds.add(refund.sourceId);
  }));
  duplicateIssues(affiliates, (row) => row.sourceId, "$.affiliates", issues);
  duplicateIssues(referralCodes, (row) => row.sourceId, "$.referralCodes", issues);
  duplicateIssues(commissions, (row) => row.sourceId, "$.commissions", issues);
  duplicateIssues(payouts, (row) => row.sourceId, "$.payouts", issues);

  const affiliateById = new Map(affiliates.map((row) => [row.sourceId, row]));
  const codeById = new Map(referralCodes.map((row) => [row.sourceId, row]));
  const commissionById = new Map(commissions.map((row) => [row.sourceId, row]));
  const affiliateEmails = new Set<string>();
  affiliates.forEach((row, index) => {
    if (row.email && affiliateEmails.has(row.email)) issues.push({ path: "$.affiliates[" + index + "].email", message: "Duplicate affiliate identity." });
    if (row.email) affiliateEmails.add(row.email);
  });
  const referralValues = new Set<string>();
  referralCodes.forEach((row, index) => {
    if (!affiliateById.has(row.affiliateSourceId)) issues.push({ path: "$.referralCodes[" + index + "].affiliateSourceId", message: "Affiliate reference does not exist in this bundle." });
    const key = row.code.toLowerCase();
    if (referralValues.has(key)) issues.push({ path: "$.referralCodes[" + index + "].code", message: "Duplicate referral code." });
    referralValues.add(key);
    for (const [aliasIndex, alias] of (row.legacyAliases ?? []).entries()) {
      if (referralValues.has(alias.toLowerCase())) {
        issues.push({ path: "$.referralCodes[" + index + "].legacyAliases[" + aliasIndex + "]", message: "Referral codes and aliases must be unique within this bundle." });
      }
      referralValues.add(alias.toLowerCase());
    }
  });
  commissions.forEach((row, index) => {
    if (!affiliateById.has(row.affiliateSourceId)) issues.push({ path: "$.commissions[" + index + "].affiliateSourceId", message: "Affiliate reference does not exist in this bundle." });
    if (row.referralCodeSourceId && !codeById.has(row.referralCodeSourceId)) issues.push({ path: "$.commissions[" + index + "].referralCodeSourceId", message: "Referral code reference does not exist in this bundle." });
    const referencedCode = row.referralCodeSourceId ? codeById.get(row.referralCodeSourceId) : undefined;
    if (referencedCode && referencedCode.affiliateSourceId !== row.affiliateSourceId) issues.push({ path: "$.commissions[" + index + "].referralCodeSourceId", message: "Referral code belongs to a different affiliate." });
  });
  payouts.forEach((row, index) => {
    if (!affiliateById.has(row.affiliateSourceId)) issues.push({ path: "$.payouts[" + index + "].affiliateSourceId", message: "Affiliate reference does not exist in this bundle." });
    row.sourceCommissionIds.forEach((sourceId, sourceIndex) => {
      if (!commissionById.has(sourceId)) issues.push({ path: "$.payouts[" + index + "].sourceCommissionIds[" + sourceIndex + "]", message: "Commission reference does not exist in this bundle." });
      const commission = commissionById.get(sourceId);
      if (commission && (commission.affiliateSourceId !== row.affiliateSourceId || commission.currency !== row.currency)) {
        issues.push({ path: "$.payouts[" + index + "].sourceCommissionIds[" + sourceIndex + "]", message: "Commission affiliate or currency does not match this payout." });
      }
    });
  });
  if (!manifest) issues.push({ path: "$.manifest", message: "Manifest is invalid." });
  if (issues.length || !manifest) return { ok: false, issues };

  const bundle: AffiliateProgramImportBundle = {
    manifest,
    affiliates: affiliates.sort((a, b) => compareStableStrings(a.sourceId, b.sourceId)),
    referralCodes: referralCodes.sort((a, b) => compareStableStrings(a.sourceId, b.sourceId)),
    commissions: commissions.sort((a, b) => compareStableStrings(a.sourceId, b.sourceId)),
    payouts: payouts.sort((a, b) => compareStableStrings(a.sourceId, b.sourceId)),
  };
  const normalizedJson = stableStringify(bundle);
  const digest = createHash("sha256").update(normalizedJson, "utf8").digest("hex");
  return { ok: true, bundle, normalizedJson, digest };
}

export function importUploadSizeIssue(input: unknown): ImportValidationIssue | null {
  let serialized: string;
  if (typeof input === "string") serialized = input;
  else {
    try {
      const result = JSON.stringify(input);
      if (typeof result !== "string") return { path: "$", message: "Upload cannot be serialized as JSON." };
      serialized = result;
    } catch {
      return { path: "$", message: "Upload cannot be serialized as JSON." };
    }
  }
  return Buffer.byteLength(serialized, "utf8") > MAX_IMPORT_UPLOAD_BYTES
    ? { path: "$", message: "Upload exceeds the 8 MiB limit." }
    : null;
}
export function validateAffiliateImportBundle(input: unknown): AffiliateImportValidation {
  const sizeIssue = importUploadSizeIssue(input);
  if (sizeIssue) return { ok: false, issues: [sizeIssue] };
  let payload = input;
  if (typeof input === "string") {
    try {
      payload = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, issues: [{ path: "$", message: "Upload is not valid JSON." }] };
    }
  }
  return validatePayload(payload);
}







