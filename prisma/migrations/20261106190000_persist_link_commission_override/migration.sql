-- The schema already used this optional per-link rate, but fresh databases
-- did not have a migration that created its column.
ALTER TABLE "AffiliateLink"
ADD COLUMN IF NOT EXISTS "commissionRateOverride" DECIMAL(5,2);
