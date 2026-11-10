import { Prisma } from "@prisma/client";

type SqlColumnNames = readonly string[];

function defineTable<
  const Name extends string,
  const Columns extends SqlColumnNames,
>(name: Name, columns: Columns) {
  const columnReferences = Object.fromEntries(
    columns.map((column) => [column, Prisma.raw(`"${column}"`)]),
  ) as Record<Columns[number], Prisma.Sql>;

  return {
    name: Prisma.raw(`"${name}"`),
    columns: columnReferences,
    ...columnReferences,
  };
}

/** PostgreSQL identifiers used by the hand-written SQL in the application. */
export const SqlSchema = {
  tables: {
    Merchant: defineTable("Merchant", ["id", "ownerId", "createdAt"]),
    Program: defineTable("Program", [
      "id",
      "merchantId",
      "minimumPayoutAmount",
    ]),
    Affiliate: defineTable("Affiliate", ["id", "merchantId"]),
    Click: defineTable("Click", [
      "id",
      "merchantId",
      "affiliateId",
      "programId",
      "expiresAt",
      "fraudConfirmedAt",
    ]),
    PaymentConnection: defineTable("PaymentConnection", [
      "merchantId",
      "provider",
      "enabled",
      "status",
      "apiKeyEnc",
    ]),
    CheckoutAttribution: defineTable("CheckoutAttribution", [
      "id",
      "merchantId",
      "provider",
      "providerCheckoutRef",
      "clickId",
      "createdAt",
    ]),
    Commission: defineTable("Commission", [
      "id",
      "affiliateId",
      "merchantId",
      "programId",
      "clickId",
      "currency",
      "amount",
      "payoutId",
      "adjustsCommissionId",
      "paymentRecordId",
      "stripePaymentRef",
      "status",
      "payableAt",
      "flagReason",
      "disputeOpenedAt",
      "checkoutConflictHeldAt",
      "createdAt",
    ]),
    Payout: defineTable("Payout", [
      "id",
      "merchantId",
      "affiliateId",
      "programId",
      "currency",
      "total",
      "paidAt",
      "isException",
      "exceptionReason",
    ]),
    PaymentRecord: defineTable("PaymentRecord", [
      "id",
      "merchantId",
      "provider",
      "checkoutId",
      "checkoutRef",
      "paymentRef",
      "status",
    ]),
    CommerceCheckout: defineTable("CommerceCheckout", [
      "id",
      "merchantId",
      "provider",
      "sourceOrderId",
      "alternateCheckoutRef",
      "hostedCheckoutRef",
      "hostedCheckoutUrl",
      "status",
      "attempts",
      "updatedAt",
    ]),
    AffiliateImportBatch: defineTable("AffiliateImportBatch", [
      "id",
      "status",
      "ownerId",
      "merchantId",
      "applyProgress",
      "mappingChoices",
      "completedAt",
    ]),
    WebhookEvent: defineTable("WebhookEvent", [
      "id",
      "merchantId",
      "provider",
      "providerEventId",
      "payload",
      "status",
      "attempts",
      "lastError",
      "nextAttemptAt",
      "createdAt",
    ]),
    ReferredSubscription: defineTable("ReferredSubscription", [
      "clickId",
      "merchantId",
      "firstPaymentRef",
      "firstPaidAt",
    ]),
  },
  types: {
    PaymentProvider: Prisma.raw('"PaymentProvider"'),
    CommissionStatus: Prisma.raw('"CommissionStatus"'),
    WebhookEventStatus: Prisma.raw('"WebhookEventStatus"'),
  },
} as const;
