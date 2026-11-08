ALTER TABLE "PaymentConnection"
    ADD COLUMN "apiAccountEmailEnc" TEXT,
    ADD COLUMN "apiAccountPasswordEnc" TEXT;

ALTER TABLE "CheckoutAttribution"
    ADD COLUMN "pollNextAt" TIMESTAMP(3),
    ADD COLUMN "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "pollFailures" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "pollLastError" TEXT,
    ADD COLUMN "pollLastAttemptAt" TIMESTAMP(3),
    ADD COLUMN "pollClosedAt" TIMESTAMP(3);

UPDATE "CheckoutAttribution"
SET "pollNextAt" = "createdAt"
WHERE "provider" = 'NOWPAYMENTS';

CREATE INDEX "CheckoutAttribution_provider_pollClosedAt_pollNextAt_idx"
    ON "CheckoutAttribution"("provider", "pollClosedAt", "pollNextAt");
