# Affiliate display currency design

## Goal

Let the admin set a default currency for each affiliate program and let each affiliate choose a preferred display currency from Account settings. The choice changes how amounts are shown, not the currencies stored for commissions or payouts.

## Current behavior

Commission and payout records retain their original ISO currency. Supaffi formats those currencies separately and does not convert totals. The chart currency picker selects one source currency for the chart; it is not a display-currency preference. Programs currently have no currency field, and the affiliate portal has no Account settings page.

An affiliate account is scoped to one merchant and currently has one program assignment. A preference can therefore apply across that affiliate portal, but it will not automatically follow the same email to a different merchant's portal.

## User experience

- The admin selects a **Program currency** when creating or editing a program. New and existing programs default to EUR.
- The affiliate gets an **Account** page in the portal with a **Display currency** setting:
  - **Use program currency (EUR)** is the default.
  - **Choose my currency** reveals a currency selector.
- The selected currency applies across the affiliate portal: overview amounts and chart, links, commission rows, and payout balances and history.
- Converted amounts carry a short note that they are estimates based on the latest available reference-rate date. The original payout currency is still used for the actual amount paid.

This follows proposal A: one explicit setting in Account, with no separate currency choice on each screen.

## Architecture

- Add `Program.currency`, stored as a lowercase ISO 4217 code and defaulting to `eur`. Existing programs receive `eur` in the migration. The field defines the affiliate display default; it does not overwrite transaction currencies.
- Add nullable `Affiliate.displayCurrency`. `null` means **Use program currency**. A selected code is the affiliate's preferred display currency across the portal for that merchant. If the admin changes the program currency, only affiliates using the program default inherit the change.
- Add currency selection to the shared program terms form, which is used by onboarding and program create/edit flows. Validate submitted codes server-side.
- Add an affiliate Account route and sidebar entry. A server action saves the preference for the authenticated affiliate only. Selecting the program default stores `null`.
- Convert each source-currency total into the selected display currency using rates with EUR as the common base, then aggregate and format the converted amounts. Apply the same rate snapshot to overview cards, chart buckets, links, commissions, and payouts so the portal stays consistent.
- Fetch rates server-side from [Frankfurter v2](https://frankfurter.dev/), cache the response for up to a day, and retain the provider's rate date for the display note. Requests contain currency codes only. Rates are informational estimates; they do not participate in payment processing.

## Failure handling and currency safety

- If the source and display currencies match, format the original amount directly.
- If rates are unavailable or a currency pair is unsupported, keep that amount in its original currency and show that conversion is unavailable. Never substitute zero or label an unconverted amount as the selected currency.
- Do not rewrite commissions, imported history, payout rows, or provider data. Do not change payout actions or imply that Supaffi executes currency exchange.
- A personal preference is per affiliate profile within one merchant portal. Sharing it across different merchants would require a cross-merchant affiliate identity that Supaffi does not currently have.

## Scope

This change adds program-default currency, an affiliate Account preference, and display-only conversion across the affiliate portal. Owner dashboard values remain in their recorded currencies. It does not change settlement, payout instructions, commission calculations, provider integrations, or imported records.

## Acceptance criteria

1. Program onboarding and create/edit forms let the admin choose a valid program currency; existing and new programs default to EUR.
2. Affiliate Account settings lets the affiliate follow the program currency or choose a personal display currency.
3. The preference persists across the affiliate portal for that merchant and does not change recorded commission or payout currencies.
4. Affiliate overview, chart, links, commissions, and payouts consistently show the selected display currency when rates are available.
5. Converted displays identify themselves as estimates and show the rate date.
6. When a conversion rate is missing or unavailable, the source amount remains visible in its original currency and the page remains usable.
7. Changing a program currency affects only affiliates inheriting the program default; explicit affiliate choices stay selected.

## Verification plan

Review the EUR default and affiliate override in the local app. Check conversions for EUR-to-USD and cross-currency amounts, same-currency formatting, unsupported-rate fallback, and that stored payout/commission values remain unchanged. No payment should be initiated.
