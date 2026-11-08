DROP INDEX IF EXISTS "CheckoutAttribution_provider_pollClosedAt_pollNextAt_idx";

ALTER TABLE "PaymentConnection"
    DROP COLUMN "apiAccountEmailEnc",
    DROP COLUMN "apiAccountPasswordEnc";

ALTER TABLE "CheckoutAttribution"
    DROP COLUMN "pollNextAt",
    DROP COLUMN "pollAttempts",
    DROP COLUMN "pollFailures",
    DROP COLUMN "pollLastError",
    DROP COLUMN "pollLastAttemptAt",
    DROP COLUMN "pollClosedAt";
