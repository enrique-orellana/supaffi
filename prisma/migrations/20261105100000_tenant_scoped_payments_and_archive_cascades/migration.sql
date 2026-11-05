-- Add the owning Merchant to Click so every provider reference can be checked
-- with a composite foreign key rather than trusting an application join.
ALTER TABLE "Click" ADD COLUMN "merchantId" TEXT;
UPDATE "Click" AS click
SET "merchantId" = affiliate."merchantId"
FROM "Affiliate" AS affiliate
WHERE affiliate."id" = click."affiliateId";
ALTER TABLE "Click" ALTER COLUMN "merchantId" SET NOT NULL;

CREATE UNIQUE INDEX "Click_id_merchantId_key" ON "Click"("id", "merchantId");
CREATE INDEX "Click_merchantId_idx" ON "Click"("merchantId");
ALTER TABLE "Click" DROP CONSTRAINT "Click_affiliateId_fkey";
ALTER TABLE "Click" ADD CONSTRAINT "Click_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Click" ADD CONSTRAINT "Click_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId") REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "CommerceCheckout_id_merchantId_key"
    ON "CommerceCheckout"("id", "merchantId");
ALTER TABLE "CommerceCheckout" DROP CONSTRAINT "CommerceCheckout_clickId_fkey";
ALTER TABLE "CommerceCheckout" ADD CONSTRAINT "CommerceCheckout_clickId_merchantId_fkey"
    FOREIGN KEY ("clickId", "merchantId") REFERENCES "Click"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentRecord" DROP CONSTRAINT "PaymentRecord_checkoutId_fkey";
ALTER TABLE "PaymentRecord" DROP CONSTRAINT "PaymentRecord_clickId_fkey";
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_checkoutId_merchantId_fkey"
    FOREIGN KEY ("checkoutId", "merchantId") REFERENCES "CommerceCheckout"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_clickId_merchantId_fkey"
    FOREIGN KEY ("clickId", "merchantId") REFERENCES "Click"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Merchant deletion remains an explicit application operation for operational
-- data. These cascades are limited to the owned Affiliate/Program subtree and
-- import archive; deleteMerchant removes live dependents before deleting the
-- Merchant, then these historical/owner rows follow it.
ALTER TABLE "Program" DROP CONSTRAINT "Program_merchantId_fkey";
ALTER TABLE "Program" ADD CONSTRAINT "Program_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Affiliate" DROP CONSTRAINT "Affiliate_merchantId_fkey";
ALTER TABLE "Affiliate" ADD CONSTRAINT "Affiliate_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Affiliate" DROP CONSTRAINT "Affiliate_programId_fkey";
ALTER TABLE "Affiliate" ADD CONSTRAINT "Affiliate_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "Program"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AffiliateImportBatch" DROP CONSTRAINT "AffiliateImportBatch_merchantId_fkey";
ALTER TABLE "AffiliateImportBatch" ADD CONSTRAINT "AffiliateImportBatch_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedCommission" DROP CONSTRAINT "ImportedCommission_batchId_fkey";
ALTER TABLE "ImportedCommission" ADD CONSTRAINT "ImportedCommission_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "AffiliateImportBatch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedPayout" DROP CONSTRAINT "ImportedPayout_batchId_fkey";
ALTER TABLE "ImportedPayout" ADD CONSTRAINT "ImportedPayout_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "AffiliateImportBatch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedCommission" DROP CONSTRAINT "ImportedCommission_merchantId_fkey";
ALTER TABLE "ImportedCommission" ADD CONSTRAINT "ImportedCommission_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportedPayout" DROP CONSTRAINT "ImportedPayout_merchantId_fkey";
ALTER TABLE "ImportedPayout" ADD CONSTRAINT "ImportedPayout_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- A row-level trigger runs at depth 1 for a normal write. During a Merchant
-- delete, FK actions run as nested triggers after the Merchant row is gone.
-- Allow only those cascade-induced archive changes; no application-set GUC can
-- opt an ordinary UPDATE or DELETE into this path.
CREATE OR REPLACE FUNCTION guard_imported_history_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    owning_merchant_id TEXT;
BEGIN
    SELECT COALESCE(OLD."merchantId", batch."merchantId")
    INTO owning_merchant_id
    FROM "AffiliateImportBatch" AS batch
    WHERE batch."id" = OLD."batchId";

    IF TG_OP IN ('UPDATE', 'DELETE')
       AND NOT EXISTS (
           SELECT 1 FROM "Merchant" AS merchant
           WHERE merchant."id" = owning_merchant_id
       ) THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Imported commission and payout history is immutable'
        USING ERRCODE = '55000';
END;
$$;

-- Prevent deleting a batch directly as a way around the archive row guard.
-- Merchant's ON DELETE CASCADE runs nested and only after the Merchant row is
-- no longer visible to this check.
CREATE FUNCTION guard_import_batch_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "Merchant" AS merchant
        WHERE merchant."id" = OLD."merchantId"
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'Imported batches can only be removed with their Merchant'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "AffiliateImportBatch_merchant_delete_only"
BEFORE DELETE ON "AffiliateImportBatch"
FOR EACH ROW EXECUTE FUNCTION guard_import_batch_delete();
