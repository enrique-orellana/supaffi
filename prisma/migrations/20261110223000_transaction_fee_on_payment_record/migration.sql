ALTER TABLE "PaymentRecord"
ADD COLUMN "providerFeeAmount" DECIMAL(18, 3),
ADD COLUMN "providerFeeSource" "ProviderFeeSource";

-- Move fee details for provider-backed payment rows out of the affiliate
-- ledger. Commission fee columns remain for the legacy Stripe flow.
UPDATE "PaymentRecord" AS payment
SET
  "providerFeeAmount" = commission."providerFeeAmount",
  "providerFeeSource" = commission."providerFeeSource"
FROM "Commission" AS commission
WHERE commission."paymentRecordId" = payment."id"
  AND payment."provider" = 'NOWPAYMENTS'::"PaymentProvider"
  AND commission."providerFeeAmount" IS NOT NULL;

UPDATE "Commission" AS commission
SET
  "providerFeeAmount" = NULL,
  "providerFeePercent" = NULL,
  "providerFeeSource" = NULL
FROM "PaymentRecord" AS payment
WHERE commission."paymentRecordId" = payment."id"
  AND payment."provider" = 'NOWPAYMENTS'::"PaymentProvider";
