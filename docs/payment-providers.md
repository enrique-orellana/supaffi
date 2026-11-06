# Payment providers

Supaffi currently has two compiled payment providers. Their checkout and commission capabilities differ.

| Provider | Supported path | Recurring commissions | Refunds and disputes |
| --- | --- | --- | --- |
| Stripe | Stripe Checkout, Payment Links, buy buttons and pricing tables | Yes, for subscriptions created through those checkout paths | Stripe refunds and disputes are processed from signed events |
| NOWPayments | One-time hosted invoices created by the signed commerce checkout endpoint below | No | A `refunded` callback voids an unpaid commission; disputes are not supported |

Supaffi records affiliate payouts but does not send them. NOWPayments does not pay affiliates in cryptocurrency, and it does not support subscription commissions. Other payment providers and direct uploads of provider exports are not supported by this release.

## Connect NOWPayments

1. Copy the API key and IPN secret from your NOWPayments account.
2. In Supaffi, open the product's **Settings → Connections** and enter both credentials. Saving new credentials replaces the previous pair; disconnecting clears them.
3. Copy the callback URL displayed by Supaffi and add it as the IPN callback URL in NOWPayments. It has this form:

   ```text
   https://supaffi.example.test/api/webhooks/nowpayments/<opaque-route-id>
   ```

   The host comes from the instance's public `SUPAFFI_DOMAIN`. Set that domain before connecting if the URL is not shown. The opaque route ID is created by Supaffi and remains available when credentials are rotated or reconnected.

Supaffi encrypts the API key and IPN secret in its database with AES-256-GCM using the instance's `MASTER_ENCRYPTION_KEY`. The credentials are not returned to the settings page after saving. Keep a secure copy of the master key separately from the database dump, but available for a restore. Treat both as sensitive: someone with both can decrypt the saved credentials.

The callback route accepts signed JSON IPNs at the copied URL. Supaffi verifies the `x-nowpayments-sig` HMAC-SHA-512 header using the saved IPN secret and canonical JSON with sorted object keys. Invalid signatures and unsupported statuses are rejected.

## Create a hosted one-time checkout

NOWPayments checkouts are created from your server through Supaffi's commerce integration. Open **Settings → Commerce integration**, create an integration secret, and copy both the integration ID and secret. Supaffi shows the secret once. It stores the secret encrypted and returns it only when you create or rotate it.

Send a server-to-server JSON `POST` to `/api/commerce/checkouts`. Sign the exact UTF-8 bytes you send: the HMAC-SHA-256 input is the Unix timestamp in seconds, a period, and the unmodified request body. Send the lowercase hexadecimal digest in `x-commerce-signature` along with `x-commerce-integration-id` and `x-commerce-timestamp`. Timestamps must be within five minutes of Supaffi's clock. Do not put the integration secret in browser code.

For example, a store backend might send this synthetic order (the referral token is a placeholder UUID):

```json
{
  "sourceOrderId": "sample-order-2048",
  "amount": "49.00",
  "currency": "EUR",
  "successUrl": "https://shop.example.test/checkout/complete",
  "cancelUrl": "https://shop.example.test/checkout/cancelled",
  "referralToken": "8b013861-714f-4cec-8a29-59e27d2e2bce"
}
```

`sourceOrderId` is your stable order ID. `amount` is a positive decimal string with up to two digits after the decimal point; Supaffi normalizes it to two digits. The success and cancel URLs must be public HTTPS URLs. Pass the referral token captured by Supaffi's tracking script from your own order flow; omit it when the order is not referred. Supaffi does not accept a customer-supplied amount or referral token as a substitute for your server's order validation.

On success, the response contains `checkoutRef` and the hosted `checkoutUrl`; redirect the customer to that URL. Once an order is ready, reusing the same order ID and identical request returns the saved checkout. Reusing that order ID with different checkout details returns a conflict.

### Checkout retries and reconciliation

- A definitive provider rejection returns HTTP `202` with `status: "pending"` and a `Retry-After` header. Retry the same order after that delay. The delay grows from one minute and is capped at six hours.
- A timeout, network failure, provider server error, or incomplete provider response can mean that an invoice was created even though Supaffi did not receive its details. Supaffi returns HTTP `202` with `status: "uncertain"` and `reconciliationRequired: true`. Repeating the request does not create another invoice.
- For an uncertain order, search the NOWPayments invoice list using `sourceOrderId`. In Settings, link the invoice you found. If no invoice exists, wait 15 minutes from the last update, confirm that you checked the provider list, and Supaffi allows one retry.

Do not generate a new order ID to bypass an uncertain result: reconcile the original order first so one purchase cannot accidentally produce two invoices.

## NOWPayments callback statuses

Supaffi currently accepts these exact lowercase `payment_status` values:

| NOWPayments status | Supaffi result |
| --- | --- |
| `waiting` | Pending; no commission |
| `confirming` | Pending; no commission |
| `confirmed` | Pending; no commission |
| `sending` | Pending; no commission |
| `partially_paid` | Pending; no commission |
| `finished` | Successful payment; can create a commission when it matches the signed checkout and its referral |
| `failed` | Failed payment; no commission |
| `expired` | Failed payment; no commission |
| `refunded` | Refunded payment; voids an unpaid commission |

For a commission, the callback must identify the saved order and match the stored checkout amount and sale currency. A valid `finished` event without a matching referred checkout is not enough to create a commission. A refund does not reverse a payout already recorded.

Statuses are applied monotonically for the same payment: a `finished` state is not regressed by a late pending, failed, or expired callback, and `refunded` remains final.

Supaffi acknowledges a valid callback after it has durably queued it; this acknowledgement does not mean commission processing has finished. Duplicate callbacks are acknowledged without queueing a second operation. If worker processing fails, Supaffi retries with exponential backoff from 30 seconds up to four hours, for at most 20 attempts (about two days). Failed events remain for operator review in the server logs/database; there is no NOWPayments event-health panel in the dashboard.

If you configure an event destination in the commerce integration settings, Supaffi can also send signed payment events to your application. See [Commerce event delivery](commerce-events.md) for the event format and receiver guidance.

## Moving from another commission writer

Use a provider-neutral cutover for each product:

1. Preview and reconcile affiliate, referral, commission, and payout history in Supaffi before changing production. Review the import report and resolve row conflicts.
2. Enable the signed checkout request and provider callbacks on a test product or isolated test flow only. Until the production cutover in step 3, send production sales exclusively to the previous commission writer. Imported links may be live in Supaffi, but do not route production sales to Supaffi during this test phase. Send a test order through the isolated flow, then confirm that Supaffi receives its successful payment event and, if configured, that your event destination receives it.
3. Cut over production atomically: disable the previous commission writer before or at the same time as routing new production orders to Supaffi. Do not let both writers process the same sale.

See the [affiliate import format](affiliate-import-format.md) for the supported canonical import bundle.
