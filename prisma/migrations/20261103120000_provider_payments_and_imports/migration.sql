CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'NOWPAYMENTS');
CREATE TYPE "CommerceEventDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED');

-- Scope live links to their Merchant. The composite foreign key also makes a
-- cross-Merchant AffiliateLink impossible at the database layer.
ALTER TABLE "AffiliateLink" ADD COLUMN "merchantId" TEXT;
UPDATE "AffiliateLink" AS link
SET "merchantId" = affiliate."merchantId"
FROM "Affiliate" AS affiliate
WHERE affiliate."id" = link."affiliateId";
ALTER TABLE "AffiliateLink" ALTER COLUMN "merchantId" SET NOT NULL;

CREATE UNIQUE INDEX "Affiliate_id_merchantId_key"
    ON "Affiliate"("id", "merchantId");
DROP INDEX "AffiliateLink_code_key";
CREATE UNIQUE INDEX "AffiliateLink_merchantId_code_key"
    ON "AffiliateLink"("merchantId", "code");
ALTER TABLE "AffiliateLink" DROP CONSTRAINT "AffiliateLink_affiliateId_fkey";
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId") REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "RetiredLinkCode_code_key";
CREATE UNIQUE INDEX "RetiredLinkCode_merchantId_code_key"
    ON "RetiredLinkCode"("merchantId", "code");

CREATE TABLE "PaymentConnection" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "apiKeyEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "externalEndpointId" TEXT,
    "webhookRouteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentConnection_merchantId_provider_key"
    ON "PaymentConnection"("merchantId", "provider");
CREATE UNIQUE INDEX "PaymentConnection_id_merchantId_provider_key"
    ON "PaymentConnection"("id", "merchantId", "provider");
CREATE UNIQUE INDEX "PaymentConnection_webhookRouteId_key"
    ON "PaymentConnection"("webhookRouteId");

-- Preserve the encrypted Stripe values byte-for-byte; this copy does not
-- decrypt, transform, or expose credential contents.
INSERT INTO "PaymentConnection" (
    "id", "merchantId", "provider", "apiKeyEnc", "webhookSecretEnc",
    "externalEndpointId", "webhookRouteId", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    merchant."id",
    'STRIPE'::"PaymentProvider",
    merchant."stripeSecretKeyEnc",
    merchant."stripeWebhookSecretEnc",
    merchant."stripeWebhookEndpointId",
    gen_random_uuid()::text,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Merchant" AS merchant
WHERE merchant."stripeSecretKeyEnc" IS NOT NULL
   OR merchant."stripeWebhookSecretEnc" IS NOT NULL
   OR merchant."stripeWebhookEndpointId" IS NOT NULL;

CREATE TABLE "CommerceIntegration" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "eventDestination" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommerceIntegration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommerceIntegration_merchantId_key"
    ON "CommerceIntegration"("merchantId");
CREATE UNIQUE INDEX "CommerceIntegration_id_merchantId_key"
    ON "CommerceIntegration"("id", "merchantId");

CREATE TABLE "AffiliateImportBatch" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "sourceAdapter" TEXT NOT NULL,
    "sourceFormatVersion" INTEGER NOT NULL,
    "normalizedDigest" TEXT NOT NULL,
    "mappingChoices" JSONB,
    "previewTotals" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "AffiliateImportBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AffiliateImportBatch_merchantId_sourceAdapter_normalizedDigest_key"
    ON "AffiliateImportBatch"("merchantId", "sourceAdapter", "normalizedDigest");
CREATE INDEX "AffiliateImportBatch_merchantId_createdAt_idx"
    ON "AffiliateImportBatch"("merchantId", "createdAt");

CREATE TABLE "CommerceCheckout" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "clickId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "successUrl" TEXT NOT NULL,
    "cancelUrl" TEXT NOT NULL,
    "hostedCheckoutRef" TEXT,
    "hostedCheckoutUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyDigest" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastCreationError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommerceCheckout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommerceCheckout_merchantId_provider_sourceOrderId_key"
    ON "CommerceCheckout"("merchantId", "provider", "sourceOrderId");
CREATE INDEX "CommerceCheckout_status_nextAttemptAt_idx"
    ON "CommerceCheckout"("status", "nextAttemptAt");

CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "sourceOrderId" TEXT,
    "checkoutId" TEXT,
    "checkoutRef" TEXT,
    "paymentRef" TEXT,
    "saleAmount" DECIMAL(18,2) NOT NULL,
    "saleCurrency" TEXT NOT NULL,
    "cryptoAmount" DECIMAL(38,18),
    "cryptoCurrency" TEXT,
    "status" TEXT NOT NULL,
    "clickId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentRecord_merchantId_provider_paymentRef_key"
    ON "PaymentRecord"("merchantId", "provider", "paymentRef");
CREATE UNIQUE INDEX "PaymentRecord_merchantId_provider_sourceOrderId_key"
    ON "PaymentRecord"("merchantId", "provider", "sourceOrderId");
CREATE INDEX "PaymentRecord_checkoutId_idx" ON "PaymentRecord"("checkoutId");
CREATE INDEX "PaymentRecord_clickId_idx" ON "PaymentRecord"("clickId");

CREATE TABLE "CommerceEventDelivery" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CommerceEventDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    CONSTRAINT "CommerceEventDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CommerceEventDelivery_eventId_key"
    ON "CommerceEventDelivery"("eventId");
CREATE INDEX "CommerceEventDelivery_status_nextAttemptAt_createdAt_idx"
    ON "CommerceEventDelivery"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "CommerceEventDelivery_merchantId_createdAt_idx"
    ON "CommerceEventDelivery"("merchantId", "createdAt");

CREATE TABLE "ImportedCommission" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "merchantId" TEXT,
    "affiliateId" TEXT,
    "sourceIdentity" TEXT NOT NULL,
    "sourceAffiliateIdentity" TEXT,
    "sourceLinkIdentity" TEXT,
    "sourceTransactionRef" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "refundedAmount" DECIMAL(18,2),
    "saleAmount" DECIMAL(18,2),
    "currency" TEXT NOT NULL,
    "originalStatus" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "sourceCreatedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportedCommission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ImportedCommission_sourceIdentity_key"
    ON "ImportedCommission"("sourceIdentity");
CREATE INDEX "ImportedCommission_batchId_importedAt_idx"
    ON "ImportedCommission"("batchId", "importedAt");
CREATE INDEX "ImportedCommission_affiliateId_sourceCreatedAt_idx"
    ON "ImportedCommission"("affiliateId", "sourceCreatedAt");

CREATE TABLE "ImportedPayout" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "merchantId" TEXT,
    "affiliateId" TEXT,
    "sourceIdentity" TEXT NOT NULL,
    "sourceAffiliateIdentity" TEXT,
    "sourceTransactionRef" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "originalStatus" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportedPayout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ImportedPayout_sourceIdentity_key"
    ON "ImportedPayout"("sourceIdentity");
CREATE INDEX "ImportedPayout_batchId_importedAt_idx"
    ON "ImportedPayout"("batchId", "importedAt");
CREATE INDEX "ImportedPayout_affiliateId_paidAt_idx"
    ON "ImportedPayout"("affiliateId", "paidAt");

ALTER TABLE "WebhookEvent"
    ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE',
    ADD COLUMN "providerEventId" TEXT;
UPDATE "WebhookEvent"
SET "provider" = 'STRIPE'::"PaymentProvider",
    "providerEventId" = "stripeEventId";
ALTER TABLE "WebhookEvent" ALTER COLUMN "stripeEventId" DROP NOT NULL;
CREATE UNIQUE INDEX "WebhookEvent_merchantId_provider_providerEventId_key"
    ON "WebhookEvent"("merchantId", "provider", "providerEventId");

ALTER TABLE "Commission" ADD COLUMN "paymentRecordId" TEXT;
CREATE UNIQUE INDEX "Commission_paymentRecordId_key"
    ON "Commission"("paymentRecordId");

ALTER TABLE "PaymentConnection" ADD CONSTRAINT "PaymentConnection_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommerceIntegration" ADD CONSTRAINT "CommerceIntegration_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffiliateImportBatch" ADD CONSTRAINT "AffiliateImportBatch_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommerceCheckout" ADD CONSTRAINT "CommerceCheckout_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommerceCheckout" ADD CONSTRAINT "CommerceCheckout_connectionId_merchantId_provider_fkey"
    FOREIGN KEY ("connectionId", "merchantId", "provider")
    REFERENCES "PaymentConnection"("id", "merchantId", "provider")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommerceCheckout" ADD CONSTRAINT "CommerceCheckout_clickId_fkey"
    FOREIGN KEY ("clickId") REFERENCES "Click"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_connectionId_merchantId_provider_fkey"
    FOREIGN KEY ("connectionId", "merchantId", "provider")
    REFERENCES "PaymentConnection"("id", "merchantId", "provider")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_checkoutId_fkey"
    FOREIGN KEY ("checkoutId") REFERENCES "CommerceCheckout"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_clickId_fkey"
    FOREIGN KEY ("clickId") REFERENCES "Click"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommerceEventDelivery" ADD CONSTRAINT "CommerceEventDelivery_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommerceEventDelivery" ADD CONSTRAINT "CommerceEventDelivery_integrationId_merchantId_fkey"
    FOREIGN KEY ("integrationId", "merchantId")
    REFERENCES "CommerceIntegration"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportedCommission" ADD CONSTRAINT "ImportedCommission_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "AffiliateImportBatch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportedCommission" ADD CONSTRAINT "ImportedCommission_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportedCommission" ADD CONSTRAINT "ImportedCommission_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportedPayout" ADD CONSTRAINT "ImportedPayout_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "AffiliateImportBatch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportedPayout" ADD CONSTRAINT "ImportedPayout_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportedPayout" ADD CONSTRAINT "ImportedPayout_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_paymentRecordId_fkey"
    FOREIGN KEY ("paymentRecordId") REFERENCES "PaymentRecord"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
