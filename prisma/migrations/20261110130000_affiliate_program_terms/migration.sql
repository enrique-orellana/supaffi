-- Keep every Affiliate override attached to the Program it configures. Clicks
-- continue to preserve the resolved rate, duration, and hold terms they saved.
CREATE TABLE "AffiliateProgramTerms" (
    "merchantId" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "customCommissionRate" DECIMAL(5, 2),
    "commissionDurationTypeOverride" "CommissionDurationType",
    "commissionDurationMonthsOverride" INTEGER,
    "attributionWindowDaysOverride" INTEGER,
    "holdingPeriodDaysOverride" INTEGER,
    "minimumPayoutAmountOverride" DECIMAL(18, 2),
    CONSTRAINT "AffiliateProgramTerms_pkey"
        PRIMARY KEY ("affiliateId", "programId"),
    CONSTRAINT "AffiliateProgramTerms_affiliateId_merchantId_fkey"
        FOREIGN KEY ("affiliateId", "merchantId")
        REFERENCES "Affiliate"("id", "merchantId")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AffiliateProgramTerms_programId_merchantId_fkey"
        FOREIGN KEY ("programId", "merchantId")
        REFERENCES "Program"("id", "merchantId")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- The previous schema stored one override set on the Affiliate's current
-- Program. Preserve that set for its current pair before removing the columns.
INSERT INTO "AffiliateProgramTerms" (
    "merchantId",
    "affiliateId",
    "programId",
    "customCommissionRate",
    "commissionDurationTypeOverride",
    "commissionDurationMonthsOverride",
    "attributionWindowDaysOverride",
    "holdingPeriodDaysOverride",
    "minimumPayoutAmountOverride"
)
SELECT
    "merchantId",
    "id",
    "programId",
    "customCommissionRate",
    "commissionDurationTypeOverride",
    "commissionDurationMonthsOverride",
    "attributionWindowDaysOverride",
    "holdingPeriodDaysOverride",
    "minimumPayoutAmountOverride"
FROM "Affiliate"
WHERE "customCommissionRate" IS NOT NULL
   OR "commissionDurationTypeOverride" IS NOT NULL
   OR "commissionDurationMonthsOverride" IS NOT NULL
   OR "attributionWindowDaysOverride" IS NOT NULL
   OR "holdingPeriodDaysOverride" IS NOT NULL
   OR "minimumPayoutAmountOverride" IS NOT NULL;

CREATE INDEX "AffiliateProgramTerms_merchantId_programId_idx"
    ON "AffiliateProgramTerms"("merchantId", "programId");

ALTER TABLE "Affiliate"
    DROP COLUMN "customCommissionRate",
    DROP COLUMN "commissionDurationTypeOverride",
    DROP COLUMN "commissionDurationMonthsOverride",
    DROP COLUMN "attributionWindowDaysOverride",
    DROP COLUMN "holdingPeriodDaysOverride",
    DROP COLUMN "minimumPayoutAmountOverride";
