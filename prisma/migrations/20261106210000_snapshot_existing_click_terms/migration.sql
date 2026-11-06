-- Clicks already have an immutable attribution expiry. Freeze their current
-- effective rate and payout hold too, so later code edits only affect new clicks.
UPDATE "Click" AS click
SET "commissionRateSnapshot" = COALESCE(
      click."commissionRateSnapshot",
      (
        SELECT link."commissionRateOverride"
        FROM "AffiliateLink" AS link
        WHERE link."id" = click."linkId"
          AND link."affiliateId" = click."affiliateId"
          AND link."merchantId" = click."merchantId"
      ),
      (
        SELECT affiliate."customCommissionRate"
        FROM "Affiliate" AS affiliate
        WHERE affiliate."id" = click."affiliateId"
          AND affiliate."merchantId" = click."merchantId"
      ),
      (
        SELECT program."defaultCommissionRate"
        FROM "Affiliate" AS affiliate
        JOIN "Program" AS program ON program."id" = affiliate."programId"
          AND program."merchantId" = affiliate."merchantId"
        WHERE affiliate."id" = click."affiliateId"
          AND affiliate."merchantId" = click."merchantId"
      )
    ),
    "holdingPeriodDaysSnapshot" = COALESCE(
      click."holdingPeriodDaysSnapshot",
      (
        SELECT link."holdingPeriodDaysOverride"
        FROM "AffiliateLink" AS link
        WHERE link."id" = click."linkId"
          AND link."affiliateId" = click."affiliateId"
          AND link."merchantId" = click."merchantId"
      ),
      (
        SELECT program."holdingPeriodDays"
        FROM "Affiliate" AS affiliate
        JOIN "Program" AS program ON program."id" = affiliate."programId"
          AND program."merchantId" = affiliate."merchantId"
        WHERE affiliate."id" = click."affiliateId"
          AND affiliate."merchantId" = click."merchantId"
      )
    )
WHERE click."commissionRateSnapshot" IS NULL
   OR click."holdingPeriodDaysSnapshot" IS NULL;
