ALTER TABLE "AffiliateLink"
ADD COLUMN "attributionWindowDaysOverride" INTEGER,
ADD COLUMN "holdingPeriodDaysOverride" INTEGER;

ALTER TABLE "Click"
ADD COLUMN "commissionRateSnapshot" DECIMAL(5,2),
ADD COLUMN "holdingPeriodDaysSnapshot" INTEGER;
