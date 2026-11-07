ALTER TABLE "AffiliateLink"
ADD COLUMN "commissionDurationTypeOverride" "CommissionDurationType",
ADD COLUMN "commissionDurationMonthsOverride" INTEGER;

ALTER TABLE "Click"
ADD COLUMN "commissionDurationTypeSnapshot" "CommissionDurationType",
ADD COLUMN "commissionDurationMonthsSnapshot" INTEGER;

-- Keep existing referrals on the program terms they were already using.
UPDATE "Click" AS click
SET "commissionDurationTypeSnapshot" = program."commissionDurationType",
    "commissionDurationMonthsSnapshot" = program."commissionDurationMonths"
FROM "Affiliate" AS affiliate
JOIN "Program" AS program
  ON program."id" = affiliate."programId"
  AND program."merchantId" = affiliate."merchantId"
WHERE affiliate."id" = click."affiliateId"
  AND affiliate."merchantId" = click."merchantId";

ALTER TABLE "AffiliateLink"
ADD CONSTRAINT "AffiliateLink_commission_duration_override_check"
CHECK (
  ("commissionDurationTypeOverride" IS NULL AND "commissionDurationMonthsOverride" IS NULL)
  OR ("commissionDurationTypeOverride" = 'FIXED_MONTHS' AND "commissionDurationMonthsOverride" > 0)
  OR ("commissionDurationTypeOverride" IN ('ONE_TIME', 'FOREVER') AND "commissionDurationMonthsOverride" IS NULL)
);
