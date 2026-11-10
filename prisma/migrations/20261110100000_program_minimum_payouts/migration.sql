-- A payout minimum belongs to the Program and is evaluated independently in
-- each commission currency. Existing programs keep today's no-minimum rule.
ALTER TABLE "Program"
    ADD COLUMN "minimumPayoutAmount" DECIMAL(18, 2) NOT NULL DEFAULT 0;

-- Freeze the Program on referral Clicks. Existing Clicks are backfilled from
-- the Affiliate's current assignment; past assignments cannot be recovered
-- for Affiliates that have since moved Programs.
ALTER TABLE "Click" ADD COLUMN "programId" TEXT;

UPDATE "Click" AS click
SET "programId" = affiliate."programId"
FROM "Affiliate" AS affiliate
WHERE affiliate."id" = click."affiliateId"
  AND affiliate."merchantId" = click."merchantId";

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "Click" WHERE "programId" IS NULL) THEN
        RAISE EXCEPTION 'Cannot assign a Program to every existing Click';
    END IF;
END;
$$;

ALTER TABLE "Click" ALTER COLUMN "programId" SET NOT NULL;
CREATE UNIQUE INDEX "Click_id_merchantId_programId_key"
    ON "Click"("id", "merchantId", "programId");
CREATE INDEX "Click_programId_idx" ON "Click"("programId");
ALTER TABLE "Click"
    ADD CONSTRAINT "Click_programId_merchantId_fkey"
    FOREIGN KEY ("programId", "merchantId")
    REFERENCES "Program"("id", "merchantId")
    ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Click" VALIDATE CONSTRAINT "Click_programId_merchantId_fkey";

CREATE FUNCTION prevent_click_program_reassignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."programId" IS DISTINCT FROM OLD."programId" THEN
        RAISE EXCEPTION 'A Click Program attribution is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Click_program_attribution_immutable"
BEFORE UPDATE OF "programId" ON "Click"
FOR EACH ROW EXECUTE FUNCTION prevent_click_program_reassignment();

-- Store the same attribution on each Commission to support a tenant-safe
-- payout foreign key and indexed balance scans. The Click remains authoritative.
ALTER TABLE "Commission" ADD COLUMN "programId" TEXT;

UPDATE "Commission" AS commission
SET "programId" = click."programId"
FROM "Click" AS click
WHERE click."id" = commission."clickId";

CREATE OR REPLACE FUNCTION enforce_commission_click_merchant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    click_merchant_id TEXT;
    click_program_id TEXT;
BEGIN
    SELECT click."merchantId", click."programId"
    INTO click_merchant_id, click_program_id
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

    IF NEW."programId" IS NOT NULL
       AND NEW."programId" <> click_program_id THEN
        RAISE EXCEPTION 'Commission Program must match its click'
            USING ERRCODE = '23514';
    END IF;

    NEW."merchantId" := click_merchant_id;
    NEW."programId" := click_program_id;
    RETURN NEW;
END;
$$;

ALTER TABLE "Commission"
    ALTER COLUMN "programId" SET NOT NULL;
ALTER TABLE "Commission"
    ADD CONSTRAINT "Commission_clickId_merchantId_programId_fkey"
    FOREIGN KEY ("clickId", "merchantId", "programId")
    REFERENCES "Click"("id", "merchantId", "programId")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Commission"
    ADD CONSTRAINT "Commission_programId_merchantId_fkey"
    FOREIGN KEY ("programId", "merchantId")
    REFERENCES "Program"("id", "merchantId")
    ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Commission" VALIDATE CONSTRAINT "Commission_clickId_merchantId_programId_fkey";
ALTER TABLE "Commission" VALIDATE CONSTRAINT "Commission_programId_merchantId_fkey";
CREATE INDEX "Commission_programId_affiliateId_currency_status_payableAt_idx"
    ON "Commission"("programId", "affiliateId", "currency", "status", "payableAt");

-- One completed, owner-confirmed external payment. A batch can only contain
-- commissions from this exact tenant, affiliate, program, and currency.
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "total" DECIMAL(18, 2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "paymentMethod" VARCHAR(80),
    "externalReference" VARCHAR(200),
    "note" VARCHAR(500),
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "exceptionReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payout_total_positive_check" CHECK ("total" > 0),
    CONSTRAINT "Payout_exception_reason_check" CHECK (
        ("isException" = false AND "exceptionReason" IS NULL) OR
        ("isException" = true AND "exceptionReason" IS NOT NULL
            AND length(trim("exceptionReason")) > 0)
    ),
    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payout_id_merchantId_affiliateId_programId_currency_key"
    ON "Payout"("id", "merchantId", "affiliateId", "programId", "currency");
CREATE INDEX "Payout_merchantId_paidAt_idx" ON "Payout"("merchantId", "paidAt");
CREATE INDEX "Payout_affiliateId_programId_currency_paidAt_idx"
    ON "Payout"("affiliateId", "programId", "currency", "paidAt");
ALTER TABLE "Commission" ADD COLUMN "payoutId" TEXT;

ALTER TABLE "Payout"
    ADD CONSTRAINT "Payout_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Payout"
    ADD CONSTRAINT "Payout_affiliateId_merchantId_fkey"
    FOREIGN KEY ("affiliateId", "merchantId")
    REFERENCES "Affiliate"("id", "merchantId")
    ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Payout"
    ADD CONSTRAINT "Payout_programId_merchantId_fkey"
    FOREIGN KEY ("programId", "merchantId")
    REFERENCES "Program"("id", "merchantId")
    ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

-- The old UI inferred payout records from exact paidAt + note values. Preserve
-- each such inferred group as a legacy batch before switching readers over.
CREATE TEMP TABLE "_legacy_payout_map" AS
SELECT
    'legacy_' || md5(
        commission."merchantId" || '|' ||
        commission."affiliateId" || '|' ||
        commission."programId" || '|' ||
        commission."currency" || '|' ||
        commission."paidAt"::TEXT || '|' ||
        COALESCE(commission."paidNote", '')
    ) AS "payoutId",
    commission."merchantId",
    commission."affiliateId",
    commission."programId",
    commission."currency",
    commission."paidAt",
    commission."paidNote",
    SUM(commission."amount") AS "total"
FROM "Commission" AS commission
WHERE commission."status" = 'PAID'::"CommissionStatus"
  AND commission."paidAt" IS NOT NULL
  AND commission."adjustsCommissionId" IS NULL
GROUP BY
    commission."merchantId",
    commission."affiliateId",
    commission."programId",
    commission."currency",
    commission."paidAt",
    commission."paidNote";

INSERT INTO "Payout" (
    "id", "merchantId", "affiliateId", "programId", "currency", "total",
    "paidAt", "note", "isException", "createdAt"
)
SELECT
    "payoutId", "merchantId", "affiliateId", "programId", "currency", "total",
    "paidAt", "paidNote", false, "paidAt"
FROM "_legacy_payout_map";

UPDATE "Commission" AS commission
SET "payoutId" = payout."payoutId"
FROM "_legacy_payout_map" AS payout
WHERE commission."merchantId" = payout."merchantId"
  AND commission."affiliateId" = payout."affiliateId"
  AND commission."programId" = payout."programId"
  AND commission."currency" = payout."currency"
  AND commission."paidAt" = payout."paidAt"
  AND commission."paidNote" IS NOT DISTINCT FROM payout."paidNote"
  AND commission."status" = 'PAID'::"CommissionStatus"
  AND commission."adjustsCommissionId" IS NULL;

ALTER TABLE "Commission"
    ADD CONSTRAINT "Commission_payoutId_merchantId_affiliateId_programId_currency_fkey"
    FOREIGN KEY ("payoutId", "merchantId", "affiliateId", "programId", "currency")
    REFERENCES "Payout"("id", "merchantId", "affiliateId", "programId", "currency")
    ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Payout" VALIDATE CONSTRAINT "Payout_merchantId_fkey";
ALTER TABLE "Payout" VALIDATE CONSTRAINT "Payout_affiliateId_merchantId_fkey";
ALTER TABLE "Payout" VALIDATE CONSTRAINT "Payout_programId_merchantId_fkey";
ALTER TABLE "Commission"
    VALIDATE CONSTRAINT "Commission_payoutId_merchantId_affiliateId_programId_currency_fkey";
