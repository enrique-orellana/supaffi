-- Credentials and endpoint identity were copied to PaymentConnection in the
-- provider connection migration. Leave those values and their connection
-- status untouched while removing the old storage columns.
ALTER TABLE "Merchant"
    DROP COLUMN "stripeSecretKeyEnc",
    DROP COLUMN "stripeWebhookSecretEnc",
    DROP COLUMN "stripeWebhookEndpointId";

-- Every existing queue row received its provider-scoped identity in the
-- provider payments migration, preserving per-Merchant duplicate handling.
ALTER TABLE "WebhookEvent"
    ALTER COLUMN "providerEventId" SET NOT NULL;
DROP INDEX "WebhookEvent_merchantId_stripeEventId_key";
ALTER TABLE "WebhookEvent"
    DROP COLUMN "stripeEventId";
