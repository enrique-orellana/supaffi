# Payment providers

Supaffi supports Stripe and NOWPayments. Stripe setup and payment handling remain provider-specific. For NOWPayments, the merchant keeps its existing checkout, invoice creation, webhook handler, and fulfillment. Supaffi needs only the NOWPayments IPN secret. It verifies the signed notification and records a sale only when its status is `finished`.

For the full sequence and a visual explanation of invoice attribution, IPN verification, and commission creation, see [the NOWPayments flow](nowpayments-flow.md).

| Provider | Supported path | Recurring commissions | Refunds and disputes |
| --- | --- | --- | --- |
| Stripe | Stripe Checkout, Payment Links, buy buttons and pricing tables | Yes, for subscriptions created through those checkout paths | Stripe refunds and disputes are processed from signed events |
| NOWPayments | One fresh hosted invoice per sale, paid once, with a signed IPN verified by Supaffi | No | A signed `refunded` status voids an unpaid commission; disputes are not supported |

Supaffi records affiliate payouts but does not send them. NOWPayments does not pay affiliates in cryptocurrency and does not support subscription commissions. Other payment providers and direct uploads of provider exports are not supported by this release.

## NOWPayments while keeping your existing callback

```mermaid
flowchart LR
  A[Affiliate link] --> B[Merchant site and Supaffi tracking script]
  B -->|Before payment: invoice reference and referral| S[Supaffi stores attribution]
  B --> C[Existing checkout]
  C --> D[NOWPayments]
  D -->|Signed IPN| E[Existing merchant webhook]
  E -->|Existing order and fulfillment flow| F[Your app]
  E -->|Custom relay forwards same body and signature| S[Supaffi webhook]
  S --> G[Verify IPN and match invoice to referral]
```

The browser registers only which referral belongs to a newly created hosted invoice. It does not report payment success. The signed NOWPayments IPN includes the payment and invoice references, amount, currency, and status. Supaffi verifies the HMAC signature using the saved IPN secret, then matches the invoice reference to the referral recorded before checkout. A commission is created only for a signed `finished` notification. Supaffi does not call NOWPayments' API or the merchant application.

1. In the product's **Settings → Connections**, save the NOWPayments IPN secret. Supaffi encrypts it in the database with AES-256-GCM using the instance's `MASTER_ENCRYPTION_KEY` and does not show it again. Supaffi does not ask for the API key, account email, password, or payout access. Your app may keep using its own API key to create invoices.
2. Add the Supaffi tracking script to the merchant site. Each sale must use a fresh NOWPayments hosted invoice and one payment ID. Automatic capture supports successful `fetch` POST requests that return the standard invoice URL in JSON. This includes same-origin requests and cross-origin requests whose response the browser allows the merchant page to read through CORS. The script reads the existing referral cookie, extracts the invoice reference, and gives Supaffi up to 800 ms to register the association before returning the response to the merchant code. Reusable invoice links, split payments, XHR, unreadable cross-origin responses, and other response shapes are not supported. If the tracker cannot identify the reference or Supaffi does not respond in time, checkout continues; that order may not be attributed.
3. Copy the callback URL shown in Supaffi settings. NOWPayments allows one callback destination. If your app already receives its IPNs, do not replace that callback with Supaffi's URL. Add a custom relay in your existing webhook or deploy the [merchant-owned relay](../integrations/nowpayments-webhook-relay/README.md). The relay must forward the original POST body and `x-nowpayments-sig` header unchanged to both your existing webhook and Supaffi.
4. If no existing system depends on the callback, set the Supaffi URL directly in NOWPayments. Otherwise, point NOWPayments at the relay, or keep the existing callback address and make that handler forward a copy to Supaffi. Your app keeps verifying its own callback and handling orders as before.
5. Supaffi verifies HMAC-SHA-512, deduplicates provider event IDs, and matches the invoice reference to the stored referral. Only a signed `finished` event can create a sale and commission. Signed failed, expired, partially paid, and refunded updates are handled according to their status.

The Supaffi receiver URL uses `SUPAFFI_WEBHOOK_BASE_URL` when configured, otherwise the public `SUPAFFI_DOMAIN`, and has this form:

```text
https://supaffi.example.test/api/webhooks/nowpayments/<opaque-route-id>
```

NOWPayments documents a callback URL for an invoice or payment and does not document multiple destinations. The relay provides the fan-out while preserving the existing webhook. If either receiver is unavailable, the relay responds with a failure so the provider can retry. Duplicate notifications remain safe because each destination handles event identity idempotently.

## NOWPayments notification statuses

Supaffi currently accepts these exact lowercase `payment_status` values:

| NOWPayments status | Supaffi result |
| --- | --- |
| `waiting` | Pending; no commission |
| `confirming` | Pending; no commission |
| `confirmed` | Pending; no commission |
| `sending` | Pending; no commission |
| `partially_paid` | Pending; no commission |
| `finished` | Successful payment confirmed by the API; can create a commission when the verified invoice reference matches a valid referral |
| `failed` | Failed payment; no commission |
| `expired` | Failed payment; no commission |
| `refunded` | Refunded payment confirmed by the API; voids an unpaid commission |

The sale amount and currency come from the verified NOWPayments notification. Statuses are applied monotonically for the same payment: a `finished` state is not regressed by a late pending, failed, or expired notification, and `refunded` remains final. A refund does not reverse a payout already recorded.

A signed payment notification without `invoice_id` is stored as an unattributed payment and does not earn a commission. Supaffi does not use the optional merchant `order_id` as a substitute for the invoice reference. If an invoice is reused, only the first completed payment can receive attribution; later payments are retained without a commission.

Supaffi acknowledges a valid notification after it has durably queued it; this acknowledgement does not mean commission processing has finished. Duplicate notifications are acknowledged without queueing a second operation. If worker processing fails, Supaffi retries with exponential backoff from 30 seconds up to four hours, for at most 20 attempts (about two days). Failed events remain for operator review in the server logs/database.

## Moving from another commission writer

Use a provider-neutral cutover for each product:

1. Preview and reconcile affiliate, referral, commission, and payout history in Supaffi before changing production. Review the import report and resolve row conflicts.
2. Test the existing checkout and merchant-owned relay on an isolated product or test flow. Confirm that Supaffi receives a successful payment notification and attributes a referred order to the expected affiliate.
3. Cut over production atomically: disable the previous commission writer before or at the same time as enabling Supaffi to process new production payments. Do not let both writers process the same sale.

See the [affiliate import format](affiliate-import-format.md) for the supported canonical import bundle.
