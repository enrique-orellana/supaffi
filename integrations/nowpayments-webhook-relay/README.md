# Merchant-owned NOWPayments webhook relay

This Cloudflare Worker forwards the same NOWPayments IPN request to two destinations:

1. The merchant's existing payment webhook, which continues handling orders and fulfillment.
2. The merchant's Supaffi NOWPayments receiver, which verifies the IPN and records affiliate commissions.

The Worker does not create invoices, inspect payment status, or decide affiliate attribution. The browser tracking script registers the checkout reference and referral before the buyer reaches the hosted invoice. The signed provider IPN remains the only payment confirmation.

```text
NOWPayments
    │ signed IPN (original JSON body + x-nowpayments-sig)
    ▼
Merchant-owned Worker
    ├── same body and signature ──> Existing merchant webhook
    └── same body and signature ──> Supaffi receiver
```

The Worker does not hold a NOWPayments API key, NOWPayments IPN secret, or merchant backend credential. It passes the provider signature unchanged; each destination verifies that signature independently.

## Configure and deploy

Use a Cloudflare account controlled by the merchant. From this directory, add the two HTTPS destinations as Worker secrets so opaque callback URLs are not committed in source:

```sh
npx wrangler secret put EXISTING_WEBHOOK_URL
npx wrangler secret put SUPAFFI_WEBHOOK_URL
npx wrangler deploy
```

Enter the full URL of the merchant's current NOWPayments webhook for `EXISTING_WEBHOOK_URL`. Copy the NOWPayments receiver URL shown in Supaffi for `SUPAFFI_WEBHOOK_URL`.

Wrangler prints the deployed Worker URL, for example `https://payment-webhook-relay.<account>.workers.dev/`. Set that URL as the NOWPayments IPN callback destination. If the existing checkout configuration sends an `ipn_callback_url` with each invoice, update that existing callback setting to the Worker URL. Keep the old webhook URL in `EXISTING_WEBHOOK_URL`; the Worker will continue forwarding to it. No checkout or fulfillment code needs to move into the Worker.

Before deploying, run the standalone tests:

```sh
npm test
```

For local Wrangler runs, put the same two values in `.dev.vars`; that file is ignored by Git.

## Delivery behavior

- Only `POST` requests with JSON content and an `x-nowpayments-sig` header are accepted.
- The request body is bounded to 64 KiB and forwarded byte-for-byte without parsing or re-serializing it.
- Both destinations are attempted, even if one is unavailable. A `2xx` from both returns `200` to NOWPayments. Any downstream error, timeout, or redirect returns `502` so NOWPayments can retry.
- A retried IPN may reach a destination that already processed it. The merchant webhook and Supaffi must keep their existing event deduplication.
- The Worker does not log the body, signature, or destination URLs.

The Worker is intentionally stateless. Checkout-to-referral association is registered separately by the tracking script before payment; this relay only forwards provider notifications.

## Test local apps through a temporary HTTPS tunnel

For a local end-to-end test, run the loopback-only relay instead of deploying the Worker. It forwards a signed IPN to the merchant's existing webhook and the local Supaffi receiver without exposing either app directly.

Create the ignored `.dev.vars` file in this directory:

```dotenv
EXISTING_WEBHOOK_URL=http://127.0.0.1:18282/webhooks/billing/nowpayments
SUPAFFI_WEBHOOK_URL=http://localhost:3000/api/webhooks/nowpayments/<connection-id>
```

Replace `<connection-id>` with the ID in the NOWPayments connection callback URL shown by Supaffi. Start the relay and then a Cloudflare Quick Tunnel in separate terminals:

```sh
node --env-file=.dev.vars local-dev-relay.mjs
cloudflared tunnel --url http://127.0.0.1:8787
```

Set NOWPayments' sandbox IPN callback URL to `https://<random-name>.trycloudflare.com/ipn`. If the merchant app sends an `ipn_callback_url` when it creates an invoice, set `APP_NOWPAYMENTS_IPN_CALLBACK_URL` and `STORE_NOWPAYMENTS_IPN_CALLBACK_URL` in its ignored sandbox environment file to that same URL. The temporary URL is public while the tunnel runs and changes when it restarts. The tunnel points only to the relay; the relay listens on loopback, accepts only `POST /ipn`, and forwards only to HTTP destinations on the same machine. Both receivers independently verify the original provider signature.

Create sandbox API credentials in NOWPayments itself. Save the sandbox API key and IPN secret in the ignored merchant sandbox environment file; do not reuse production credentials. The API key creates invoices; the IPN secret verifies callbacks.
