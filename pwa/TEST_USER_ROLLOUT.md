# PriceCheck Controlled Test-User Rollout

## Purpose and scope

This is a **private, invitation-only validation round** for the mobile-first PriceCheck PWA. It is intended to measure barcode scanning, exact retailer coverage, response times, and user comprehension before any public deployment. The PWA does not require accounts during this round; participants should receive the temporary HTTPS test link directly from the project owner.

## What a successful scan saves

The backend stores market data, not user identities or per-user histories.

| Scan outcome | Shared backend behaviour | What the participant sees |
|---|---|---|
| A new barcode receives one or more exact retailer prices | The canonical product record is upserted and every returned retailer price is appended to shared price history. The product becomes searchable for later users. | Ranked retailer rows with source timestamps. |
| The barcode already has a fresh cached price | The backend returns the cache and does not need to create a duplicate price record. | Fast result with the existing retailer price and freshness time. |
| No retailer returns an exact EAN match | No price record is invented or saved. Product metadata may be displayed only when a live source supplies it. | A not-found screen or visible unavailable rows with an explanation. |
| A provider or network request fails | No successful price is persisted for that retailer. | A source-temporary-unavailable explanation or retry path. |

The current PWA stores the most recently viewed product locally in that browser. It does **not** create a shared user profile, personal scan history, or account record.

## Recommended first cohort

Invite **five testers** for the first round. Ask each person to scan or enter **five different packaged grocery products**, using a mix of food, household, and personal-care categories. This creates a target set of about 25 unique lookups, which is sufficient to identify coverage patterns while preserving the managed data provider’s free credit allowance.

Participants should not repeatedly press Refresh or share the temporary link outside the test group. The backend applies a 30-request-per-15-minute per-client limit and does not expose provider credentials. The managed provider’s account-wide credit and rate limits remain the practical constraint, so usage should remain focused on unique product tests.

## Participant instructions

1. Open the temporary test link in Safari on iPhone or Chrome on Android.
2. Scan a retail EAN/UPC barcode, or enter its digits manually if camera permission is unavailable.
3. Wait for the result; do not scan again while the loading screen is visible.
4. Record whether the camera recognised the barcode, whether the product name was correct, which retailer rows had prices, and whether the result loaded in a reasonable time.
5. If a product is unavailable, capture a screenshot and the barcode. This is useful coverage information, not necessarily a defect.
6. Enter `0000000000000` once to confirm the not-found experience does not show an unrelated product.

## Feedback template

| Field | Example |
|---|---|
| Phone and browser | iPhone 15, Safari |
| Barcode | `6009702444031` |
| Scan detected | Yes / No |
| Product identity correct | Yes / No / Partially |
| Retailers with a price | Checkers |
| Time to result | Approximately 6 seconds |
| Screenshot or issue | Optional image plus short description |

## What to measure

At the end of the first cohort, assess camera detection success, exact product-match correctness, proportion of scans receiving at least one price, average observed response time, provider errors, and user understanding of the unavailable retailer explanations. Keep a small barcode coverage register by category and retailer rather than importing a complete catalogue upfront.

## Before expanding the cohort

Do not invite more testers until the first 25-lookups round is reviewed. Increase to 15 to 20 invited users only after confirming that the provider’s credit balance, response time, exact-match rule, and backend rate limit are appropriate. Add test-user accounts only when the next product requirement is personal scan history, saved products, or price alerts.
