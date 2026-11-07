-- NOWPayments relay verification uses only its IPN secret. Discard saved API
-- keys for this provider while leaving Stripe credentials untouched.
UPDATE "PaymentConnection"
SET "apiKeyEnc" = NULL
WHERE "provider" = 'NOWPAYMENTS';
