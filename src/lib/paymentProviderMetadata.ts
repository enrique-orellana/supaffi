import type { Prisma } from "@prisma/client";

export type SafeProviderMetadataValue =
  | string
  | number
  | boolean
  | null
  | SafeProviderMetadataValue[]
  | { [key: string]: SafeProviderMetadataValue };

export type NowPaymentsFeeMetadata = {
  currency?: string;
  depositFee?: string;
  serviceFee?: string;
  withdrawalFee?: string;
};

export type NowPaymentsPaymentMetadata = {
  paymentId?: string;
  invoiceId?: string;
  orderId?: string;
  purchaseId?: string;
  parentPaymentId?: string;
  status?: string;
  orderDescription?: string;
  priceAmount?: string;
  priceCurrency?: string;
  payAmount?: string;
  payCurrency?: string;
  actuallyPaid?: string;
  payAddress?: string;
  payinExtraId?: string;
  paymentExtraIds?: SafeProviderMetadataValue;
  outcomeAmount?: string;
  outcomeCurrency?: string;
  fee?: NowPaymentsFeeMetadata;
};

export type PaymentProviderMetadata = Prisma.InputJsonObject;

export type ProviderMetadataRow = {
  path: string;
  label: string;
  value: string;
  copyable?: boolean;
};

const MAX_PAYMENT_EXTRA_IDS_BYTES = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown, maxLength: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  )
    return undefined;
  return value;
}

function readIdentifier(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? String(value) : undefined;
  return readText(value, 256);
}

function readAmount(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0 ? String(value) : undefined;
  if (typeof value !== "string" || value.length > 64) return undefined;
  return /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?(?:[eE][+-]?\d{1,2})?$/.test(value)
    ? value
    : undefined;
}

function readCurrency(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_-]{2,20}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function safeExtraValue(
  value: unknown,
  depth = 0,
): SafeProviderMetadataValue | undefined {
  if (value === null) return undefined;
  if (typeof value === "string") return value.length <= 512 ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : undefined;
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) {
    if (value.length > 20) return undefined;
    const values = value
      .map((item) => safeExtraValue(item, depth + 1))
      .filter((item): item is SafeProviderMetadataValue => item !== undefined);
    return values.length > 0 ? values : undefined;
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 20) return undefined;
  const safeEntries = entries.flatMap(([key, item]) => {
    if (!/^[a-z0-9_-]{1,64}$/i.test(key)) return [];
    const safeValue = safeExtraValue(item, depth + 1);
    return safeValue === undefined ? [] : [[key, safeValue] as const];
  });
  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
}

function readPaymentExtraIds(
  value: unknown,
): SafeProviderMetadataValue | undefined {
  const safeValue = safeExtraValue(value);
  if (safeValue === undefined) return undefined;

  const serialized = JSON.stringify(safeValue);
  return serialized !== undefined &&
    new TextEncoder().encode(serialized).byteLength <=
      MAX_PAYMENT_EXTRA_IDS_BYTES
    ? safeValue
    : undefined;
}

/** Extract a small, bounded set of NOWPayments tracing fields from a callback. */
export function extractNowPaymentsMetadata(
  payload: Record<string, unknown>,
): PaymentProviderMetadata | null {
  const metadata: NowPaymentsPaymentMetadata = {};
  const assign = <K extends keyof NowPaymentsPaymentMetadata>(
    key: K,
    value: NowPaymentsPaymentMetadata[K] | undefined,
  ) => {
    if (value !== undefined) metadata[key] = value;
  };

  assign("paymentId", readIdentifier(payload.payment_id));
  assign("invoiceId", readIdentifier(payload.invoice_id));
  assign("orderId", readIdentifier(payload.order_id));
  assign("purchaseId", readIdentifier(payload.purchase_id));
  assign("parentPaymentId", readIdentifier(payload.parent_payment_id));
  assign("status", readText(payload.payment_status, 40));
  assign("orderDescription", readText(payload.order_description, 512));
  assign("priceAmount", readAmount(payload.price_amount));
  assign("priceCurrency", readCurrency(payload.price_currency));
  assign("payAmount", readAmount(payload.pay_amount));
  assign("payCurrency", readCurrency(payload.pay_currency));
  assign("actuallyPaid", readAmount(payload.actually_paid));
  assign("payAddress", readText(payload.pay_address, 512));
  assign("payinExtraId", readText(payload.payin_extra_id, 256));
  assign("paymentExtraIds", readPaymentExtraIds(payload.payment_extra_ids));
  assign("outcomeAmount", readAmount(payload.outcome_amount));
  assign("outcomeCurrency", readCurrency(payload.outcome_currency));

  const rawFee = payload.fee;
  if (isRecord(rawFee)) {
    const fee: NowPaymentsFeeMetadata = {};
    const currency = readCurrency(rawFee.currency);
    const depositFee = readAmount(rawFee.depositFee);
    const serviceFee = readAmount(rawFee.serviceFee);
    const withdrawalFee = readAmount(rawFee.withdrawalFee);
    if (currency !== undefined) fee.currency = currency;
    if (depositFee !== undefined) fee.depositFee = depositFee;
    if (serviceFee !== undefined) fee.serviceFee = serviceFee;
    if (withdrawalFee !== undefined) fee.withdrawalFee = withdrawalFee;
    if (Object.keys(fee).length > 0) metadata.fee = fee;
  }

  return Object.keys(metadata).length > 0
    ? ({ nowpayments: metadata } as PaymentProviderMetadata)
    : null;
}

/** Merge a later callback without discarding fields absent from that callback. */
export function mergeNowPaymentsMetadata(
  existing: unknown,
  incoming: PaymentProviderMetadata,
): PaymentProviderMetadata {
  const existingRoot = isRecord(existing) ? existing : {};
  const existingNowPayments = isRecord(existingRoot.nowpayments)
    ? existingRoot.nowpayments
    : {};
  const incomingNowPaymentsValue: unknown = incoming.nowpayments;
  const incomingNowPayments = isRecord(incomingNowPaymentsValue)
    ? incomingNowPaymentsValue
    : {};
  const existingFee = isRecord(existingNowPayments.fee)
    ? existingNowPayments.fee
    : {};
  const incomingFee = isRecord(incomingNowPayments.fee)
    ? incomingNowPayments.fee
    : {};
  const fee = { ...existingFee, ...incomingFee };

  return {
    ...existingRoot,
    nowpayments: {
      ...existingNowPayments,
      ...incomingNowPayments,
      ...(Object.keys(fee).length > 0 ? { fee } : {}),
    },
  } as PaymentProviderMetadata;
}

function humanizeMetadataSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word, index) => {
      if (word.toLowerCase() === "id") return "ID";
      const normalized = word.toLowerCase();
      return index === 0
        ? normalized[0]!.toUpperCase() + normalized.slice(1)
        : normalized;
    })
    .join(" ");
}

function flattenMetadataRows(
  value: Record<string, unknown>,
  path: string[],
  rows: ProviderMetadataRow[],
): void {
  for (const [key, nested] of Object.entries(value)) {
    if (nested === null || nested === undefined) continue;

    const nestedPath = [...path, key];
    if (isRecord(nested)) {
      flattenMetadataRows(nested, nestedPath, rows);
      continue;
    }

    const renderedValue =
      typeof nested === "string"
        ? nested
        : Array.isArray(nested)
          ? JSON.stringify(nested)
          : String(nested);
    rows.push({
      path: nestedPath.join("."),
      label: nestedPath
        .map(humanizeMetadataSegment)
        .map((segment, index) =>
          index === 0 ? segment : segment.toLowerCase(),
        )
        .join(" "),
      value: renderedValue,
      ...(/(?:id|address)$/i.test(key) ? { copyable: true } : {}),
    });
  }
}

/** Flatten saved provider metadata into field rows without provider-specific sections. */
export function providerMetadataRows(
  provider: string | null | undefined,
  value: unknown,
): ProviderMetadataRow[] | null {
  if (!provider || !isRecord(value)) return null;

  const providerMetadata = value[provider.toLowerCase()];
  if (!isRecord(providerMetadata)) return null;

  const rows: ProviderMetadataRow[] = [];
  flattenMetadataRows(providerMetadata, [], rows);
  return rows.length > 0 ? rows : null;
}
