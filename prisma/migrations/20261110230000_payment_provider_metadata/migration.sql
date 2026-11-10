ALTER TABLE "PaymentRecord"
ADD COLUMN "providerMetadata" JSONB;

-- Backfill the selected NOWPayments fields from retained verified webhook
-- events so existing payment records can show the same admin tracing details.
WITH finished_events AS (
  SELECT DISTINCT ON (
    event."merchantId",
    event.payload ->> 'paymentRef'
  )
    event."merchantId",
    event.payload ->> 'paymentRef' AS "paymentRef",
    event.payload -> 'rawPayload' AS raw_payload
  FROM "WebhookEvent" AS event
  WHERE event."provider" = 'NOWPAYMENTS'::"PaymentProvider"
    AND event.payload ->> 'provider' = 'nowpayments'
    AND event.payload ->> 'kind' = 'payment_succeeded'
    AND event.payload -> 'rawPayload' ->> 'payment_status' = 'finished'
    AND event.payload ->> 'paymentRef' IS NOT NULL
  ORDER BY
    event."merchantId",
    event.payload ->> 'paymentRef',
    event."createdAt" DESC
)
UPDATE "PaymentRecord" AS payment
SET "providerMetadata" = jsonb_build_object(
  'nowpayments',
  jsonb_strip_nulls(jsonb_build_object(
    'paymentId', CASE
      WHEN length(event.raw_payload ->> 'payment_id') <= 256
        THEN event.raw_payload -> 'payment_id'
    END,
    'invoiceId', CASE
      WHEN length(event.raw_payload ->> 'invoice_id') <= 256
        THEN event.raw_payload -> 'invoice_id'
    END,
    'orderId', CASE
      WHEN length(event.raw_payload ->> 'order_id') <= 256
        THEN event.raw_payload -> 'order_id'
    END,
    'purchaseId', CASE
      WHEN length(event.raw_payload ->> 'purchase_id') <= 256
        THEN event.raw_payload -> 'purchase_id'
    END,
    'parentPaymentId', CASE
      WHEN length(event.raw_payload ->> 'parent_payment_id') <= 256
        THEN event.raw_payload -> 'parent_payment_id'
    END,
    'status', CASE
      WHEN length(event.raw_payload ->> 'payment_status') <= 40
        THEN event.raw_payload -> 'payment_status'
    END,
    'orderDescription', CASE
      WHEN length(event.raw_payload ->> 'order_description') <= 512
        THEN event.raw_payload -> 'order_description'
    END,
    'priceAmount', CASE
      WHEN length(event.raw_payload ->> 'price_amount') <= 64
        THEN event.raw_payload -> 'price_amount'
    END,
    'priceCurrency', CASE
      WHEN length(event.raw_payload ->> 'price_currency') <= 20
        THEN event.raw_payload -> 'price_currency'
    END,
    'payAmount', CASE
      WHEN length(event.raw_payload ->> 'pay_amount') <= 64
        THEN event.raw_payload -> 'pay_amount'
    END,
    'payCurrency', CASE
      WHEN length(event.raw_payload ->> 'pay_currency') <= 20
        THEN event.raw_payload -> 'pay_currency'
    END,
    'actuallyPaid', CASE
      WHEN length(event.raw_payload ->> 'actually_paid') <= 64
        THEN event.raw_payload -> 'actually_paid'
    END,
    'payAddress', CASE
      WHEN length(event.raw_payload ->> 'pay_address') <= 512
        THEN event.raw_payload -> 'pay_address'
    END,
    'payinExtraId', CASE
      WHEN length(event.raw_payload ->> 'payin_extra_id') <= 256
        THEN event.raw_payload -> 'payin_extra_id'
    END,
    'paymentExtraIds', CASE
      WHEN octet_length((event.raw_payload -> 'payment_extra_ids')::text) <= 1024
        THEN event.raw_payload -> 'payment_extra_ids'
    END,
    'outcomeAmount', CASE
      WHEN length(event.raw_payload ->> 'outcome_amount') <= 64
        THEN event.raw_payload -> 'outcome_amount'
    END,
    'outcomeCurrency', CASE
      WHEN length(event.raw_payload ->> 'outcome_currency') <= 20
        THEN event.raw_payload -> 'outcome_currency'
    END,
    'fee', CASE
      WHEN jsonb_typeof(event.raw_payload -> 'fee') = 'object' THEN
        jsonb_strip_nulls(jsonb_build_object(
          'currency', CASE
            WHEN length(event.raw_payload -> 'fee' ->> 'currency') <= 20
              THEN event.raw_payload -> 'fee' -> 'currency'
          END,
          'depositFee', CASE
            WHEN length(event.raw_payload -> 'fee' ->> 'depositFee') <= 64
              THEN event.raw_payload -> 'fee' -> 'depositFee'
          END,
          'serviceFee', CASE
            WHEN length(event.raw_payload -> 'fee' ->> 'serviceFee') <= 64
              THEN event.raw_payload -> 'fee' -> 'serviceFee'
          END,
          'withdrawalFee', CASE
            WHEN length(event.raw_payload -> 'fee' ->> 'withdrawalFee') <= 64
              THEN event.raw_payload -> 'fee' -> 'withdrawalFee'
          END
        ))
      ELSE NULL
    END
  ))
)
FROM finished_events AS event
WHERE payment."merchantId" = event."merchantId"
  AND payment."provider" = 'NOWPAYMENTS'::"PaymentProvider"
  AND payment."paymentRef" = event."paymentRef"
  AND payment."providerMetadata" IS NULL;
