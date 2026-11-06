-- Imports are owner-scoped. A batch still records its source Merchant, but
-- archived rows may map to any Merchant and Program owned by the same Owner.
ALTER TABLE "Merchant"
    ADD CONSTRAINT "Merchant_id_ownerId_key" UNIQUE ("id", "ownerId");
ALTER TABLE "Program"
    ADD CONSTRAINT "Program_id_merchantId_key" UNIQUE ("id", "merchantId");

ALTER TABLE "AffiliateImportBatch"
    ADD COLUMN "ownerId" TEXT,
    ADD COLUMN "applyProgress" JSONB;
UPDATE "AffiliateImportBatch" AS batch
SET "ownerId" = merchant."ownerId"
FROM "Merchant" AS merchant
WHERE merchant."id" = batch."merchantId";
ALTER TABLE "AffiliateImportBatch" ALTER COLUMN "ownerId" SET NOT NULL;
ALTER TABLE "AffiliateImportBatch"
    DROP CONSTRAINT IF EXISTS "AffiliateImportBatch_merchantId_fkey";
ALTER TABLE "AffiliateImportBatch"
    ADD CONSTRAINT "AffiliateImportBatch_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "Owner"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AffiliateImportBatch"
    ADD CONSTRAINT "AffiliateImportBatch_merchantId_ownerId_fkey"
    FOREIGN KEY ("merchantId", "ownerId") REFERENCES "Merchant"("id", "ownerId")
    ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "AffiliateImportBatch_id_ownerId_key"
    ON "AffiliateImportBatch"("id", "ownerId");
CREATE INDEX "AffiliateImportBatch_ownerId_createdAt_idx"
    ON "AffiliateImportBatch"("ownerId", "createdAt");

ALTER TABLE "Affiliate"
    ADD COLUMN "importSourceIdentity" TEXT;
CREATE UNIQUE INDEX "Affiliate_importSourceIdentity_key"
    ON "Affiliate"("importSourceIdentity");
ALTER TABLE "AffiliateLink"
    ADD COLUMN "legacyAliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "legacyQueryParamAliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "importSourceIdentity" TEXT;
CREATE UNIQUE INDEX "AffiliateLink_importSourceIdentity_key"
    ON "AffiliateLink"("importSourceIdentity");

-- The previous guard allows only nested Merchant-delete cascades. Temporarily
-- remove it while the additive backfill adds owner/allocation metadata. Existing
-- historical Merchant/Affiliate references and Decimal values are preserved.
DROP TRIGGER IF EXISTS "ImportedCommission_immutable_history" ON "ImportedCommission";
DROP TRIGGER IF EXISTS "ImportedPayout_immutable_history" ON "ImportedPayout";

ALTER TABLE "ImportedCommission"
    DROP CONSTRAINT IF EXISTS "ImportedCommission_batchId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedCommission_batchId_merchantId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedCommission_merchantId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedCommission_affiliateId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedCommission_affiliateId_merchantId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedCommission_affiliate_requires_merchant_check";
ALTER TABLE "ImportedCommission"
    ADD COLUMN "ownerId" TEXT,
    ADD COLUMN "targetOwnerId" TEXT,
    ADD COLUMN "targetProgramId" TEXT,
    ADD COLUMN "sourceProductIdentity" TEXT,
    ADD COLUMN "allocationStatus" TEXT NOT NULL DEFAULT 'UNALLOCATED',
    ADD COLUMN "amountMinor" BIGINT,
    ADD COLUMN "refundedMinor" BIGINT,
    ADD COLUMN "refunds" JSONB,
    ADD COLUMN "saleAmountMinor" BIGINT;
UPDATE "ImportedCommission" AS imported
SET "ownerId" = batch."ownerId",
    "amountMinor" = NULL,
    "refundedMinor" = NULL,
    "saleAmountMinor" = NULL,
    "targetOwnerId" = (SELECT merchant."ownerId" FROM "Merchant" AS merchant WHERE merchant."id" = imported."merchantId"),
    "targetProgramId" = NULL,
    "allocationStatus" = 'UNALLOCATED'
FROM "AffiliateImportBatch" AS batch
WHERE batch."id" = imported."batchId";
ALTER TABLE "ImportedCommission"
    ALTER COLUMN "ownerId" SET NOT NULL,
    ALTER COLUMN "amount" TYPE DECIMAL(24, 6) USING "amount"::DECIMAL(24, 6),
    ALTER COLUMN "refundedAmount" TYPE DECIMAL(24, 6) USING "refundedAmount"::DECIMAL(24, 6),
    ALTER COLUMN "saleAmount" TYPE DECIMAL(24, 6) USING "saleAmount"::DECIMAL(24, 6);

ALTER TABLE "ImportedPayout"
    DROP CONSTRAINT IF EXISTS "ImportedPayout_batchId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedPayout_batchId_merchantId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedPayout_merchantId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedPayout_affiliateId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedPayout_affiliateId_merchantId_fkey",
    DROP CONSTRAINT IF EXISTS "ImportedPayout_affiliate_requires_merchant_check";
ALTER TABLE "ImportedPayout"
    ADD COLUMN "ownerId" TEXT,
    ADD COLUMN "targetOwnerId" TEXT,
    ADD COLUMN "targetProgramId" TEXT,
    ADD COLUMN "sourceProductIdentity" TEXT,
    ADD COLUMN "sourceCommissionIdentities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "allocationStatus" TEXT NOT NULL DEFAULT 'UNALLOCATED',
    ADD COLUMN "amountMinor" BIGINT;
UPDATE "ImportedPayout" AS imported
SET "ownerId" = batch."ownerId",
    "amountMinor" = NULL,
    "targetOwnerId" = (SELECT merchant."ownerId" FROM "Merchant" AS merchant WHERE merchant."id" = imported."merchantId"),
    "targetProgramId" = NULL,
    "allocationStatus" = 'UNALLOCATED'
FROM "AffiliateImportBatch" AS batch
WHERE batch."id" = imported."batchId";
ALTER TABLE "ImportedPayout"
    ALTER COLUMN "ownerId" SET NOT NULL,
    ALTER COLUMN "amount" TYPE DECIMAL(24, 6) USING "amount"::DECIMAL(24, 6);

ALTER TABLE "ImportedCommission"
    ADD CONSTRAINT "ImportedCommission_batchId_ownerId_fkey"
    FOREIGN KEY ("batchId", "ownerId") REFERENCES "AffiliateImportBatch"("id", "ownerId")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ImportedCommission_merchantId_targetOwnerId_fkey"
    FOREIGN KEY ("merchantId", "targetOwnerId") REFERENCES "Merchant"("id", "ownerId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "ImportedCommission_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId") REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "ImportedCommission_targetProgramId_merchantId_fkey"
    FOREIGN KEY ("targetProgramId", "merchantId") REFERENCES "Program"("id", "merchantId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "ImportedCommission_target_owner_check"
    CHECK ("targetOwnerId" IS NULL OR "targetOwnerId" = "ownerId"),
    ADD CONSTRAINT "ImportedCommission_allocation_check"
    CHECK (("allocationStatus" = 'UNALLOCATED' AND ("targetProgramId" IS NULL OR "merchantId" IS NOT NULL)) OR
           ("merchantId" IS NOT NULL AND "targetProgramId" IS NOT NULL AND "targetOwnerId" = "ownerId" AND "allocationStatus" = 'ALLOCATED')),
    ADD CONSTRAINT "ImportedCommission_affiliate_requires_merchant_check"
    CHECK ("affiliateId" IS NULL OR "merchantId" IS NOT NULL);
ALTER TABLE "ImportedPayout"
    ADD CONSTRAINT "ImportedPayout_batchId_ownerId_fkey"
    FOREIGN KEY ("batchId", "ownerId") REFERENCES "AffiliateImportBatch"("id", "ownerId")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ImportedPayout_merchantId_targetOwnerId_fkey"
    FOREIGN KEY ("merchantId", "targetOwnerId") REFERENCES "Merchant"("id", "ownerId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "ImportedPayout_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId") REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "ImportedPayout_targetProgramId_merchantId_fkey"
    FOREIGN KEY ("targetProgramId", "merchantId") REFERENCES "Program"("id", "merchantId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "ImportedPayout_target_owner_check"
    CHECK ("targetOwnerId" IS NULL OR "targetOwnerId" = "ownerId"),
    ADD CONSTRAINT "ImportedPayout_allocation_check"
    CHECK (("allocationStatus" = 'UNALLOCATED' AND ("targetProgramId" IS NULL OR "merchantId" IS NOT NULL)) OR
           ("merchantId" IS NOT NULL AND "targetProgramId" IS NOT NULL AND "targetOwnerId" = "ownerId" AND "allocationStatus" = 'ALLOCATED')),
    ADD CONSTRAINT "ImportedPayout_affiliate_requires_merchant_check"
    CHECK ("affiliateId" IS NULL OR "merchantId" IS NOT NULL);

CREATE INDEX "ImportedCommission_ownerId_allocationStatus_idx"
    ON "ImportedCommission"("ownerId", "allocationStatus");
CREATE INDEX "ImportedPayout_ownerId_allocationStatus_idx"
    ON "ImportedPayout"("ownerId", "allocationStatus");

CREATE TABLE "AffiliateImportRowResult" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "targetMerchantId" TEXT,
    "targetOwnerId" TEXT,
    "sourceIdentity" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "currency" TEXT,
    "amountMinor" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AffiliateImportRowResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AffiliateImportRowResult_batchId_sourceIdentity_key"
    ON "AffiliateImportRowResult"("batchId", "sourceIdentity");
CREATE INDEX "AffiliateImportRowResult_batchId_sourceKind_outcome_idx"
    ON "AffiliateImportRowResult"("batchId", "sourceKind", "outcome");
CREATE INDEX "AffiliateImportRowResult_ownerId_batchId_id_idx"
    ON "AffiliateImportRowResult"("ownerId", "batchId", "id");
ALTER TABLE "AffiliateImportRowResult"
    ADD CONSTRAINT "AffiliateImportRowResult_batchId_ownerId_fkey"
    FOREIGN KEY ("batchId", "ownerId") REFERENCES "AffiliateImportBatch"("id", "ownerId")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AffiliateImportRowResult_targetMerchantId_targetOwnerId_fkey"
    FOREIGN KEY ("targetMerchantId", "targetOwnerId") REFERENCES "Merchant"("id", "ownerId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "AffiliateImportRowResult_target_owner_check"
    CHECK (("targetMerchantId" IS NULL AND "targetOwnerId" IS NULL) OR
           ("targetMerchantId" IS NOT NULL AND "targetOwnerId" = "ownerId"));

CREATE OR REPLACE FUNCTION guard_imported_history_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_merchant_id TEXT;
BEGIN
    SELECT batch."merchantId"
    INTO source_merchant_id
    FROM "AffiliateImportBatch" AS batch
    WHERE batch."id" = OLD."batchId" AND batch."ownerId" = OLD."ownerId";

    IF TG_OP IN ('UPDATE', 'DELETE')
       AND NOT EXISTS (
           SELECT 1 FROM "Merchant" AS merchant
           WHERE merchant."id" = source_merchant_id
       ) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Imported commission and payout history is immutable'
        USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "ImportedCommission_immutable_history"
BEFORE UPDATE OR DELETE ON "ImportedCommission"
FOR EACH ROW EXECUTE FUNCTION guard_imported_history_immutability();
CREATE TRIGGER "ImportedPayout_immutable_history"
BEFORE UPDATE OR DELETE ON "ImportedPayout"
FOR EACH ROW EXECUTE FUNCTION guard_imported_history_immutability();

-- Each target is checked against the batch owner, target Merchant, affiliate,
-- and Program. The composite foreign keys enforce tenant membership even if
-- a caller bypasses the owner-scoped server action.
