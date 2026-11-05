-- Imported rows may keep both tenant mappings NULL when no mapping was
-- allocated. When a Merchant is mapped, it must be the batch's Merchant; a
-- mapped Affiliate must belong to that same Merchant.
CREATE UNIQUE INDEX "AffiliateImportBatch_id_merchantId_key"
    ON "AffiliateImportBatch"("id", "merchantId");

CREATE INDEX "ImportedCommission_merchantId_idx"
    ON "ImportedCommission"("merchantId");
CREATE INDEX "ImportedPayout_merchantId_idx"
    ON "ImportedPayout"("merchantId");

ALTER TABLE "ImportedCommission"
    DROP CONSTRAINT "ImportedCommission_affiliateId_fkey";
ALTER TABLE "ImportedCommission"
    ADD CONSTRAINT "ImportedCommission_batchId_merchantId_fkey"
    FOREIGN KEY ("batchId", "merchantId")
    REFERENCES "AffiliateImportBatch"("id", "merchantId")
    ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ImportedCommission"
    ADD CONSTRAINT "ImportedCommission_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId")
    REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ImportedCommission"
    ADD CONSTRAINT "ImportedCommission_affiliate_requires_merchant_check"
    CHECK ("affiliateId" IS NULL OR "merchantId" IS NOT NULL) NOT VALID;

ALTER TABLE "ImportedPayout"
    DROP CONSTRAINT "ImportedPayout_affiliateId_fkey";
ALTER TABLE "ImportedPayout"
    ADD CONSTRAINT "ImportedPayout_batchId_merchantId_fkey"
    FOREIGN KEY ("batchId", "merchantId")
    REFERENCES "AffiliateImportBatch"("id", "merchantId")
    ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ImportedPayout"
    ADD CONSTRAINT "ImportedPayout_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId")
    REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ImportedPayout"
    ADD CONSTRAINT "ImportedPayout_affiliate_requires_merchant_check"
    CHECK ("affiliateId" IS NULL OR "merchantId" IS NOT NULL) NOT VALID;

-- Validate existing archive rows before the migration completes. Inconsistent
-- mappings are deliberately not rewritten because history is immutable; a
-- dirty archive fails migration and needs an explicit, reviewed reconciliation.
ALTER TABLE "ImportedCommission"
    VALIDATE CONSTRAINT "ImportedCommission_batchId_merchantId_fkey";
ALTER TABLE "ImportedCommission"
    VALIDATE CONSTRAINT "ImportedCommission_affiliateId_merchantId_fkey";
ALTER TABLE "ImportedCommission"
    VALIDATE CONSTRAINT "ImportedCommission_affiliate_requires_merchant_check";
ALTER TABLE "ImportedPayout"
    VALIDATE CONSTRAINT "ImportedPayout_batchId_merchantId_fkey";
ALTER TABLE "ImportedPayout"
    VALIDATE CONSTRAINT "ImportedPayout_affiliateId_merchantId_fkey";
ALTER TABLE "ImportedPayout"
    VALIDATE CONSTRAINT "ImportedPayout_affiliate_requires_merchant_check";
