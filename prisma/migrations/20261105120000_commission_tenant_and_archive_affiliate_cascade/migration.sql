-- Keep a Commission's provider-neutral payment reference in the same tenant
-- as the required Click. The application supplies merchantId, and the trigger
-- derives it for legacy/direct create paths while rejecting mismatches.
ALTER TABLE "Commission" ADD COLUMN "merchantId" TEXT;

CREATE FUNCTION enforce_commission_click_merchant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    click_merchant_id TEXT;
BEGIN
    SELECT click."merchantId"
    INTO click_merchant_id
    FROM "Click" AS click
    WHERE click."id" = NEW."clickId";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Commission click does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF NEW."merchantId" IS NOT NULL
       AND NEW."merchantId" <> click_merchant_id THEN
        RAISE EXCEPTION 'Commission merchant must match its click'
            USING ERRCODE = '23514';
    END IF;

    NEW."merchantId" := click_merchant_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Commission_derive_merchant_from_click"
BEFORE INSERT OR UPDATE ON "Commission"
FOR EACH ROW EXECUTE FUNCTION enforce_commission_click_merchant();

UPDATE "Commission" AS commission
SET "merchantId" = click."merchantId"
FROM "Click" AS click
WHERE click."id" = commission."clickId"
  AND commission."merchantId" IS DISTINCT FROM click."merchantId";

ALTER TABLE "Commission"
    ADD CONSTRAINT "Commission_merchantId_not_null_check"
    CHECK ("merchantId" IS NOT NULL) NOT VALID;
ALTER TABLE "Commission"
    ADD CONSTRAINT "Commission_paymentRecord_requires_merchant_check"
    CHECK ("paymentRecordId" IS NULL OR "merchantId" IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX "PaymentRecord_merchantId_id_key"
    ON "PaymentRecord"("merchantId", "id");

-- Click is already tenant-scoped. This second FK makes the copied Commission
-- tenant agree with both its required Click and its optional PaymentRecord.
ALTER TABLE "Commission"
    ADD CONSTRAINT "Commission_clickId_merchantId_fkey"
    FOREIGN KEY ("clickId", "merchantId")
    REFERENCES "Click"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- The original single-column FK keeps its ON DELETE SET NULL behavior. This
-- deferred composite FK enforces tenant equality while allowing that action
-- to clear only paymentRecordId before the transaction commits.
ALTER TABLE "Commission"
    ADD CONSTRAINT "Commission_merchantId_paymentRecordId_fkey"
    FOREIGN KEY ("merchantId", "paymentRecordId")
    REFERENCES "PaymentRecord"("merchantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE "Commission"
    VALIDATE CONSTRAINT "Commission_merchantId_not_null_check";
ALTER TABLE "Commission"
    VALIDATE CONSTRAINT "Commission_paymentRecord_requires_merchant_check";
ALTER TABLE "Commission"
    VALIDATE CONSTRAINT "Commission_clickId_merchantId_fkey";
ALTER TABLE "Commission"
    VALIDATE CONSTRAINT "Commission_merchantId_paymentRecordId_fkey";

-- Affiliate deletion must not rewrite immutable imported rows. CASCADE makes
-- ordinary Affiliate deletion attempt a guarded archive DELETE, which fails
-- while its Merchant exists. During Merchant deletion, the existing trigger
-- permits that cascade once the owning Merchant row is no longer visible.
ALTER TABLE "ImportedCommission"
    DROP CONSTRAINT "ImportedCommission_affiliateId_merchantId_fkey";
ALTER TABLE "ImportedCommission"
    ADD CONSTRAINT "ImportedCommission_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId")
    REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportedPayout"
    DROP CONSTRAINT "ImportedPayout_affiliateId_merchantId_fkey";
ALTER TABLE "ImportedPayout"
    ADD CONSTRAINT "ImportedPayout_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId")
    REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE CASCADE ON UPDATE CASCADE;
