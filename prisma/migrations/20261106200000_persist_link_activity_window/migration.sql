-- These nullable fields are already part of the link model and are read by
-- referral tracking and payment processing.
ALTER TABLE "AffiliateLink"
ADD COLUMN IF NOT EXISTS "activeFrom" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "activeUntil" TIMESTAMP(3);
