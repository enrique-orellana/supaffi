# Affiliate display currency design

## Goal

Let the admin set a default affiliate display currency for each program, let each affiliate choose a preferred display currency, and let the owner choose a global dashboard display currency. These choices change visualization only, not the currencies stored for commissions or payouts.

## Current behavior

Commission and payout records retain their original ISO currency. Programs have a currency field used as the affiliate display default, and affiliates can override it in Settings. The owner dashboard now has its own account-wide display preference; its overview totals and charts use reference-rate estimates while individual commission and payout rows and Program settings retain their original currencies.

An affiliate account is scoped to one merchant and currently has one program assignment. A preference can therefore apply across that affiliate portal, but it will not automatically follow the same email to a different merchant's portal.

## User experience

- The admin selects a **Default affiliate display currency** when creating or editing a program. New and existing programs default to EUR.
- The owner selects **Dashboard display currency** in Account settings. It defaults to EUR and applies across the owner's product overview visualizations.
- The affiliate gets a **Settings** page in the portal with a **Display currency** setting:
  - **Use program default (EUR)** is the default.
  - **Choose my currency** reveals a currency selector.
- The selected currency applies across the affiliate portal: overview amounts and chart, links, commission rows, and payout balances and history.
- Commission and payout history rows show the original amount and currency beside an estimated converted amount. The original payout currency remains the amount actually paid.
- Converted summaries carry a short note that they are estimates based on the reference-rate date. The affiliate-facing target choices are USD, GBP, CAD, EUR, AUD, and NZD.

This follows proposal A: one explicit setting in Settings, with no separate currency choice on each screen.

## Architecture

- Add `Program.currency`, stored as a lowercase ISO 4217 code and defaulting to `eur`. Existing programs receive `eur` in the migration. The field defines the affiliate display default; it does not overwrite transaction currencies.
- Add nullable `Affiliate.displayCurrency`. `null` means **Use program default**. A selected code is the affiliate's preferred display currency across the portal for that merchant. If the admin changes the program default, only affiliates using it inherit the change.
- Add `Owner.displayCurrency`, defaulting to EUR. This account-wide preference applies to overview totals, chart buckets, and top-affiliate amounts across the owner's products.
- Add currency selection to the shared program terms form, which is used by onboarding and program create/edit flows. Validate submitted codes server-side.
- Add an affiliate Settings route and sidebar entry. A server action saves the preference for the authenticated affiliate only. Selecting the program default stores `null`.
- Convert each source-currency total into the selected display currency using rates with EUR as the common base, then aggregate and format the converted amounts. Convert source groups separately before totaling; never add unlike currencies directly. Apply the same rate snapshot to overview cards, chart buckets, links, commissions, and payouts so the portal stays consistent.
- Keep source amounts and currencies visible on individual commission and payout history rows beside their estimated converted values. Never replace the underlying source amount with its display estimate.
- For the owner dashboard, convert aggregate overview values and chart buckets only. Keep the individual commission and payout ledger amounts and configured Program currencies as their original values.
- Fetch rates server-side from [Frankfurter v2](https://frankfurter.dev/), cache the response for up to a day, and retain the provider's rate date for the display note. Requests contain currency codes only. Rates are informational estimates; they do not participate in payment processing.

## Failure handling and currency safety

- If the source and display currencies match, format the original amount directly.
- If rates are unavailable or a currency pair is unsupported, keep that amount in its original currency and show that conversion is unavailable. In totals and chart buckets, leave the amount out of the selected-currency sum and show a separate source-currency breakdown. Never substitute zero or label an unconverted amount as the selected currency.
- Do not rewrite commissions, imported history, payout rows, or provider data. Do not change payout actions or imply that Supaffi executes currency exchange.
- A personal preference is per affiliate profile within one merchant portal. Sharing it across different merchants would require a cross-merchant affiliate identity that Supaffi does not currently have.

## Scope

This change includes a program-default display currency, an affiliate Settings preference, an owner-wide Account preference, and display-only conversion in affiliate views and owner overview visualizations. It does not change settlement, payout instructions, commission calculations, provider integrations, Program settings, or imported records.

## Acceptance criteria

1. Program onboarding and create/edit forms let the admin choose a valid program currency; existing and new programs default to EUR.
2. Affiliate Settings lets the affiliate follow the program default or choose a personal display currency.
3. The preference persists across the affiliate portal for that merchant and does not change recorded commission or payout currencies.
4. Affiliate overview, chart, links, commissions, and payouts consistently show the selected display currency when rates are available; commission and payout history rows retain and show their original amount and currency beside the converted estimate.
5. Converted displays identify themselves as estimates and show the rate date.
6. When a conversion rate is missing or unavailable, the source amount remains visible in its original currency and the page remains usable.
7. Changing a program currency affects only affiliates inheriting the program default; explicit affiliate choices stay selected.
8. Changing the owner's Account display currency updates overview visualizations across products, while individual commission and payout rows and Program currency settings remain unchanged.

## Verification plan

Review the EUR defaults, affiliate override, and owner Account preference in the local app. Check conversions for EUR-to-USD and cross-currency amounts, same-currency formatting, unsupported-rate fallback, and that stored payout/commission values and Program currencies remain unchanged. No payment should be initiated.
