# Affiliate import bundle format

This document defines the versioned, provider-neutral JSON format used to preview affiliate program history imports. A bundle describes affiliate identities, referral codes and scopes, commission rows, and payout snapshots. Preview is a dry run; it does not write affiliate, referral, commission, or payout records. In this release, the only compiled importer is `canonical-json` version 1. Source-platform exports are not accepted unless a matching adapter has been compiled into the server.

## Limits and privacy

- The upload limit is 8 MiB. Larger payloads are rejected before parsing.
- The canonical format does not accept passwords, customer email addresses, payment credentials, card or bank details, wallet addresses, or raw payment data. Unknown fields are rejected with a path-specific validation message.
- An affiliate row may include an affiliate contact email for identity conflict checks. It remains in memory during validation and preview; it is never stored in the preview batch.
- The preview batch stores only the source adapter ID, format version, SHA-256 digest of the normalized bundle, mapping choices, aggregate counts and sums, and preview status. The uploaded bundle and row-level personal data are not persisted. After application, the separate history report stores source IDs, outcomes, non-personal reasons, and currency minor-unit amounts so the owner can download a complete row-level CSV.

## Version 1 shape

All four row collections and the manifest are required. Collections may be empty. IDs are stable source-system identifiers using letters, digits, `.`, `_`, `:`, or `-`, up to 160 characters. Referral codes and legacy aliases use letters, digits, `.`, `_`, or `-`, up to 100 characters.

```json
{
  "manifest": {
    "format": "affiliate-program",
    "version": 1,
    "sourceAdapter": "canonical-json",
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
      "commissionRateOverrideBps": 1500,
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
- Referral scope is either `{ "kind": "merchant" }` or `{ "kind": "product", "productSourceId": "..." }`. Product IDs remain source identifiers until the owner explicitly maps each one to a target Merchant and Program owned by the same account. Merchant-wide links use an owner-selected default Merchant+Program pair. A code may include `commissionRateOverrideBps` (0–10,000 basis points); at runtime this link override takes precedence over the affiliate's custom rate, which takes precedence over the Program default. A code can also include `activeFrom`, `activeUntil`, and old code values in `legacyAliases`.
- Commission and payout amounts are non-negative integer strings in the currency's minor unit. Commission `amountMinor` and payout `amountMinor` must be positive; `refundedMinor` may be zero but cannot exceed the commission amount. Optional `refunds` rows carry refund source IDs, ISO timestamps, and minor-unit amounts; when present, their sum must equal `refundedMinor`. No currency conversion occurs. Currency codes are normalized to uppercase and must be supported ISO 4217 codes.
- Commission status is `pending`, `payable`, `paid`, `voided`, `refunded`, or `flagged`. Payout status is `paid`, `pending`, or `voided`.
- Commission and payout rows include source IDs and event timestamps. Payout snapshots also identify the source commission rows they summarize. Period boundaries and references are checked for valid order and consistency.
- References to affiliates, referral codes, and commissions must resolve within the same bundle. Duplicate IDs, duplicate referral codes, duplicate affiliate email identities, malformed identifiers, invalid timestamps, invalid currencies, and broken references are rejected with a JSON path such as `$.commissions[2].affiliateSourceId`.

## Adapter boundary and legacy query aliases

An adapter is compiled into the server-side registry, converts a source payload to this canonical version in memory, and declares the canonical versions it supports. The adapter contract is:

```ts
type AffiliateImportAdapter = {
  id: string;
  supportedVersions: readonly number[];
  legacyQueryParamAliases?: readonly string[];
  toCanonicalBundle(input: unknown): unknown | Promise<unknown>;
};
```

For example, the compiled `canonical-json` adapter declares `supportedVersions: [1]` and returns its input unchanged for validation. The adapter name in the manifest must match a registered adapter and its supported version. This release does not compile source-platform adapters; the example manifest above uses only the built-in canonical JSON adapter. Unknown adapter IDs and unsupported versions are rejected. Uploaded bundles can never provide or execute adapter code. Source-specific credentials and export files are not part of the canonical bundle. Import confirmation requires the same file and digest to be uploaded again; confirmed data is applied in resumable chunks.

An adapter may declare legacy query parameter names it recognizes. A referral row may provide historical code values in `legacyAliases`. The Merchant-scoped tracking script forwards only query parameters declared by the imported links' adapter. `canonical-json` currently declares no legacy query parameter aliases. When an adapter does declare them, the server resolves a parameter/value pair only against imported links in the Merchant identified by the request host. Missing, ambiguous, or cross-Merchant matches fail closed; aliases never create or resolve a link across Merchant boundaries.

## Preview behavior

The dry-run preview validates the entire bundle and reports:

- row counts and active referral links;
- commission gross, refunded, and net minor-unit totals by currency, plus payout totals by currency;
- product scopes that cannot be mapped and mapped target products marked untrustworthy;
- rate, affiliate identity, and referral code conflicts against the target Merchant.

A preview creates a new `AffiliateImportBatch` or updates an existing `PREVIEW` batch keyed by source Merchant, adapter, and normalized digest. A completed batch remains read-only; batches in any other non-preview state are also left unchanged and return a blocking message. Normalization sorts rows and unordered nested ID lists, validates calendar timestamps, normalizes timestamps and currency codes, and hashes the stable JSON encoding with SHA-256. Before application, the owner maps each source product to a target Merchant+Program pair owned by that same account. Affiliate identity mapping is explicit per target Merchant; an exact email match is shown as a conflict and is never merged automatically. Confirmation locks the batch and requires the submitted choices to match the choices saved by the latest preview. No source payload or row-level affiliate data is saved.

Applied commission and payout rows remain immutable owner-scoped history. They are not operational commissions, payout totals, or payment instructions. A payout snapshot is allocated only when all referenced commission rows resolve to one target Merchant+Program pair; ambiguous snapshots remain a single unallocated archive row.

Imported rows are history only; they do not become payment-provider events or activate commission processing. Review the preview and completed history report before switching any live commission writer. Follow the generic cutover order in [Payment providers](payment-providers.md#moving-from-another-commission-writer).

Application is owner-only and resumable. It creates live links only for tracking-verified target Merchants and removes batch-created affiliates that end with no live link. Affiliate email mappings require an explicit owner choice with the same normalized email in the selected target Merchant and Program. The owner can download a complete CSV containing outcome rows for all source affiliates, links, commissions, and payouts; it does not include affiliate emails or the uploaded bundle.


