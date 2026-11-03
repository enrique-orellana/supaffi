CREATE TYPE "PaymentConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');

ALTER TABLE "PaymentConnection"
    ADD COLUMN "status" "PaymentConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false;

-- Existing Stripe credentials were already live before this generic
-- connection record was introduced. Preserve that activation while carrying
-- forward a connected status only when both required secrets are present.
UPDATE "PaymentConnection"
SET "status" = CASE
        WHEN "apiKeyEnc" IS NOT NULL AND "webhookSecretEnc" IS NOT NULL
            THEN 'CONNECTED'::"PaymentConnectionStatus"
        ELSE 'DISCONNECTED'::"PaymentConnectionStatus"
    END,
    "enabled" = true
WHERE "provider" = 'STRIPE'::"PaymentProvider";

ALTER TABLE "PaymentRecord"
    ADD COLUMN "cryptoNetwork" TEXT;

-- Imported history is immutable in ordinary writes. Merchant deletion is the
-- one supported cleanup path: deleteMerchant sets this transaction-local
-- marker after its ownership check and deletes rows for that merchant's batch.
CREATE FUNCTION guard_imported_history_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('supaffi.archive_purge_merchant_id', true) = (
           SELECT batch."merchantId"
           FROM "AffiliateImportBatch" AS batch
           WHERE batch."id" = OLD."batchId"
       ) THEN
        RETURN OLD;
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

CREATE FUNCTION reject_imported_history_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Imported commission and payout history is immutable'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "ImportedCommission_no_truncate"
BEFORE TRUNCATE ON "ImportedCommission"
FOR EACH STATEMENT EXECUTE FUNCTION reject_imported_history_truncate();

CREATE TRIGGER "ImportedPayout_no_truncate"
BEFORE TRUNCATE ON "ImportedPayout"
FOR EACH STATEMENT EXECUTE FUNCTION reject_imported_history_truncate();
