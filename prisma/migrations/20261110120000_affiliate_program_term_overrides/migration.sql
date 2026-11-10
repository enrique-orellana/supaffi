ALTER TABLE "Affiliate"
ADD COLUMN "commissionDurationTypeOverride" "CommissionDurationType",
ADD COLUMN "commissionDurationMonthsOverride" INTEGER,
ADD COLUMN "attributionWindowDaysOverride" INTEGER,
ADD COLUMN "holdingPeriodDaysOverride" INTEGER,
ADD COLUMN "minimumPayoutAmountOverride" DECIMAL(18,2);
