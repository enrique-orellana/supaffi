import { PaymentProvider } from "@/lib/payments/types";

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

export type PaymentProviderMetadata = {
  nowpayments?: NowPaymentsPaymentMetadata;
};

export type ProviderMetadataRow = {
  label: string;
  value: string;
  copyable?: boolean;
};

export type ProviderMetadataGroup = {
  title: string;
  rows: ProviderMetadataRow[];
};

export type ProviderMetadataDisplay = {
  title: string;
  groups: ProviderMetadataGroup[];
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

  return Object.keys(metadata).length > 0 ? { nowpayments: metadata } : null;
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
  const incomingNowPayments = incoming.nowpayments ?? {};
  const existingFee = isRecord(existingNowPayments.fee)
    ? existingNowPayments.fee
    : {};
  const incomingFee = incomingNowPayments.fee ?? {};
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

function displayAmount(amount?: string, currency?: string): string | undefined {
  if (!amount) return undefined;
  return currency ? `${amount} ${currency.toUpperCase()}` : amount;
}

function stringValue(value: SafeProviderMetadataValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function row(
  label: string,
  value: string | undefined,
  copyable = false,
): ProviderMetadataRow | null {
  return value === undefined || value.length === 0
    ? null
    : { label, value, ...(copyable ? { copyable: true } : {}) };
}

function group(
  title: string,
  rows: Array<ProviderMetadataRow | null>,
): ProviderMetadataGroup | null {
  const visibleRows = rows.filter(
    (item): item is ProviderMetadataRow => item !== null,
  );
  return visibleRows.length > 0 ? { title, rows: visibleRows } : null;
}

/** Build the admin detail groups for provider metadata; unknown providers stay hidden. */
export function providerMetadataDisplay(
  provider: string | null | undefined,
  value: unknown,
): ProviderMetadataDisplay | null {
  if (provider !== PaymentProvider.NOWPAYMENTS.database || !isRecord(value))
    return null;
  const metadata = value.nowpayments;
  if (!isRecord(metadata)) return null;

  const fee = isRecord(metadata.fee) ? metadata.fee : {};
  const feeCurrency = readCurrency(fee.currency)?.toUpperCase();
  const feeAmount = (amount: unknown) => {
    const parsed = readAmount(amount);
    return parsed === undefined
      ? undefined
      : feeCurrency
        ? `${parsed} ${feeCurrency}`
        : parsed;
  };
  const extraIds = safeExtraValue(metadata.paymentExtraIds);
  const groups = [
    group("References", [
      row("Payment ID", readIdentifier(metadata.paymentId), true),
      row("Invoice ID", readIdentifier(metadata.invoiceId), true),
      row("Order ID", readIdentifier(metadata.orderId), true),
      row("Purchase ID", readIdentifier(metadata.purchaseId), true),
      row("Parent payment ID", readIdentifier(metadata.parentPaymentId), true),
      row("Payment status", readText(metadata.status, 40)),
    ]),
    group("Sale and settlement", [
      row(
        "Sale price",
        displayAmount(
          readAmount(metadata.priceAmount),
          readCurrency(metadata.priceCurrency),
        ),
      ),
      row(
        "Pay amount",
        displayAmount(
          readAmount(metadata.payAmount),
          readCurrency(metadata.payCurrency),
        ),
      ),
      row(
        "Actually paid",
        displayAmount(
          readAmount(metadata.actuallyPaid),
          readCurrency(metadata.payCurrency),
        ),
      ),
      row(
        "Outcome amount",
        displayAmount(
          readAmount(metadata.outcomeAmount),
          readCurrency(metadata.outcomeCurrency),
        ),
      ),
    ]),
    group("Processor fee breakdown", [
      row("Deposit fee", feeAmount(fee.depositFee)),
      row("Service fee", feeAmount(fee.serviceFee)),
      row("Withdrawal fee", feeAmount(fee.withdrawalFee)),
    ]),
    group("Payment details", [
      row("Description", readText(metadata.orderDescription, 512)),
      row("Payment address", readText(metadata.payAddress, 512), true),
      row("Pay-in extra ID", readIdentifier(metadata.payinExtraId), true),
      row(
        "Payment extra IDs",
        extraIds === undefined ? undefined : stringValue(extraIds),
        true,
      ),
    ]),
  ].filter((item): item is ProviderMetadataGroup => item !== null);

  return groups.length > 0 ? { title: "NOWPayments metadata", groups } : null;
}
