# Affiliate import bundle format

This document defines the versioned, provider-neutral JSON format used to preview affiliate program history imports. A bundle describes affiliate identities, referral codes and scopes, commission rows, and payout snapshots. Preview is a dry run; it does not write affiliate, referral, commission, or payout records.

## Limits and privacy

- The upload limit is 8 MiB. Larger payloads are rejected before parsing.
- The canonical format does not accept passwords, customer email addresses, payment credentials, card or bank details, wallet addresses, or raw payment data. Unknown fields are rejected with a path-specific validation message.
- An affiliate row may include an affiliate contact email for identity conflict checks. It remains in memory during validation and preview; it is never stored in the preview batch.
- The preview batch stores only the source adapter ID, format version, SHA-256 digest of the normalized bundle, mapping choices, aggregate counts and sums, and preview status. The uploaded bundle and row-level personal data are not persisted.

## Version 1 shape

All four row collections and the manifest are required. Collections may be empty. IDs are stable source-system identifiers using letters, digits, `.`, `_`, `:`, or `-`, up to 160 characters. Referral codes and legacy aliases use letters, digits, `.`, `_`, or `-`, up to 100 characters.

```json
{
  "manifest": {
    "format": "affiliate-program",
    "version": 1,
    "sourceAdapter": "example-export",
    "generatedAt": "2026-10-31T18:45:00.000Z"
  },
  "affiliates": [
    {
      "sourceId": "affiliate-104",
      "displayName": "Example Partner",
      "email": "partner@example.test",
      "commissionRateBps": 1250
    }
  ],
  "referralCodes": [
    {
      "sourceId": "link-104-main",
      "affiliateSourceId": "affiliate-104",
      "code": "PARTNER104",
      "scope": { "kind": "product", "productSourceId": "product-pro" },
      "status": "active",
      "createdAt": "2026-10-01T09:00:00Z",
      "activeFrom": "2026-10-01T09:00:00Z",
      "legacyAliases": ["old-partner-104"]
    }
  ],
  "commissions": [
    {
      "sourceId": "commission-9001",
      "affiliateSourceId": "affiliate-104",
      "referralCodeSourceId": "link-104-main",
      "sourceOrderId": "order-9001",
      "sourceTransactionId": "transaction-9001",
      "occurredAt": "2026-10-15T12:30:00Z",
      "currency": "EUR",
      "amountMinor": "1250",
      "refundedMinor": "250",
      "refunds": [
        { "sourceId": "refund-3001", "occurredAt": "2026-10-20T14:00:00Z", "amountMinor": "250" }
      ],
      "saleAmountMinor": "10000",
      "status": "pending"
    }
  ],
  "payouts": [
    {
      "sourceId": "payout-77",
      "affiliateSourceId": "affiliate-104",
      "sourceCommissionIds": ["commission-9001"],
      "periodStart": "2026-10-01T00:00:00Z",
      "periodEnd": "2026-10-31T23:59:59Z",
      "paidAt": "2026-11-01T09:00:00Z",
      "currency": "EUR",
      "amountMinor": "1000",
      "status": "paid"
    }
  ]
}
```

### Field rules

- `manifest.format` is `affiliate-program`; only version `1` is currently supported. `sourceAdapter` is a stable adapter identifier, and `generatedAt` is an ISO 8601 timestamp with a timezone.
- Affiliate `email` and `displayName` are optional. `commissionRateBps` is an integer from 0 to 10,000 (basis points: 1,250 is 12.5%).
- Referral scope is either `{ "kind": "merchant" }` or `{ "kind": "product", "productSourceId": "..." }`. Product IDs remain source identifiers until the owner maps them to products in the same Merchant. A code can optionally include `activeFrom`, `activeUntil`, and old code values in `legacyAliases`.
- Commission and payout amounts are non-negative integer strings in the currency's minor unit. Commission `amountMinor` and payout `amountMinor` must be positive; `refundedMinor` may be zero but cannot exceed the commission amount. Optional `refunds` rows carry refund source IDs, ISO timestamps, and minor-unit amounts; when present, their sum must equal `refundedMinor`. No currency conversion occurs. Currency codes are normalized to uppercase and must be supported ISO 4217 codes.
- Commission status is `pending`, `payable`, `paid`, `voided`, `refunded`, or `flagged`. Payout status is `paid`, `pending`, or `voided`.
- Commission and payout rows include source IDs and event timestamps. Payout snapshots also identify the source commission rows they summarize. Period boundaries and references are checked for valid order and consistency.
- References to affiliates, referral codes, and commissions must resolve within the same bundle. Duplicate IDs, duplicate referral codes, duplicate affiliate email identities, malformed identifiers, invalid timestamps, invalid currencies, and broken references are rejected with a JSON path such as `$.commissions[2].affiliateSourceId`.

## Adapter boundary and legacy query aliases

An adapter converts a source payload to this canonical version in memory and declares the format versions it supports. Source-specific credentials and export files are not part of the canonical bundle.

An adapter may declare legacy query parameter names it recognizes. A referral row may provide historical code values in `legacyAliases`. Resolution succeeds only when the alias value identifies exactly one imported referral link belonging to the same Merchant. Missing, ambiguous, or cross-Merchant matches fail closed; aliases never create or resolve a link across Merchant boundaries.

## Preview behavior

The dry-run preview validates the entire bundle and reports:

- row counts and active referral links;
- commission gross, refunded, and net minor-unit totals by currency, plus payout totals by currency;
- product scopes that cannot be mapped and mapped target products marked untrustworthy;
- rate, affiliate identity, and referral code conflicts against the target Merchant.

A preview creates a new `AffiliateImportBatch` or updates an existing `PREVIEW` batch keyed by Merchant, adapter, and normalized digest. A completed batch remains read-only; batches in any other non-preview state are also left unchanged and return a blocking message. Normalization sorts rows and unordered nested ID lists, validates calendar timestamps, normalizes timestamps and currency codes, and hashes the stable JSON encoding with SHA-256. Mapping targets are accepted only when they belong to the preview's Merchant. No source payload or row-level affiliate data is saved.


