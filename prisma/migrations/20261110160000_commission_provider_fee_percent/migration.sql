ALTER TABLE "Commission"
ADD COLUMN "providerFeePercent" DECIMAL(5, 2);

UPDATE "Commission"
SET "providerFeePercent" = ROUND(
  "providerFeeAmount" * 100 / NULLIF("saleAmount", 0),
  2
)
WHERE "providerFeeAmount" IS NOT NULL
  AND "providerFeeSource" IS NOT NULL
  AND "saleAmount" > 0;
