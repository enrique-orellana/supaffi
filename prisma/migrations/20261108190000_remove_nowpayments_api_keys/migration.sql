-- NOWPayments payment verification uses the signed IPN body and IPN secret.
-- API keys remain available for Stripe in the shared connection table, but
-- NOWPayments must not retain one.
UPDATE "PaymentConnection"
SET "apiKeyEnc" = NULL
WHERE "provider" = 'NOWPAYMENTS';
