CREATE TYPE "ProviderFeeSource" AS ENUM ('ACTUAL', 'FALLBACK');

ALTER TABLE "PaymentConnection"
ADD COLUMN "feeFallbackPercent" DECIMAL(5, 2);

ALTER TABLE "PaymentConnection"
ADD CONSTRAINT "PaymentConnection_feeFallbackPercent_range"
CHECK (
  "feeFallbackPercent" IS NULL OR
  ("feeFallbackPercent" >= 0 AND "feeFallbackPercent" <= 100)
);

ALTER TABLE "Commission"
ADD COLUMN "providerFeeAmount" DECIMAL(18, 2),
ADD COLUMN "providerFeeSource" "ProviderFeeSource";
