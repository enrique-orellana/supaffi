-- Commission.merchantId is derived from Click by the preceding migration.
-- Verify existing Commission, Click, and Affiliate ownership before adding a
-- tenant-scoped Affiliate reference. Leave mismatches untouched and fail with
-- a clear reconciliation error.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Commission" AS commission
        JOIN "Click" AS click
          ON click."id" = commission."clickId"
        JOIN "Affiliate" AS affiliate
          ON affiliate."id" = commission."affiliateId"
        WHERE commission."merchantId" IS DISTINCT FROM click."merchantId"
           OR affiliate."merchantId" IS DISTINCT FROM click."merchantId"
    ) THEN
        RAISE EXCEPTION 'Commission affiliate, merchant, and click must belong to the same Merchant'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

-- Keep Prisma's existing single-column Affiliate relation intact so its
-- generated Commission create input continues to allow merchantId omission;
-- the trigger fills that value from Click. This additional FK closes the
-- cross-Merchant Affiliate gap without changing deleteMerchant's ordering.
ALTER TABLE "Commission"
    ADD CONSTRAINT "Commission_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId")
    REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- NOT VALID protects new writes immediately; validation checks every existing
-- Commission before the migration completes.
ALTER TABLE "Commission"
    VALIDATE CONSTRAINT "Commission_affiliateId_merchantId_fkey";
