# PriceCheck: Controlled Phone Test Checklist

## Purpose

Validate the mobile-first PWA on a real phone before any public deployment. This is a temporary controlled test; the source repositories remain private and the test URL should not be shared beyond the test group.

## Known live test product

Use **EAN-13 `6001069600754`**, which is currently verified in the live backend as **Ouma Buttermilk Rusks Sliced 450g**.

Expected result:

| Retailer | Expected state |
|---|---|
| Checkers | Available, **R62.99**, `Best price` |
| Pick n Pay | Available, **R63.99**, ranked second |
| Woolworths | Visible `Not available` row for this EAN |
| SPAR | Visible `Not available` row because national store-independent prices are not supplied |

## Test sequence

1. Open the temporary test link in Safari on iPhone or Chrome on Android.
2. Confirm that the Home screen is readable without horizontal scrolling and that Search and Scan links work.
3. Open **Search**, manually enter `6001069600754`, and confirm the expected four-retailer result above.
4. Open **Scan**. The rear camera should request permission automatically, with no separate “Open camera” action. Place only the barcode lines inside the horizontal green band, then move slightly closer or farther until the lines are sharp. If scanning is unavailable, record the exact browser/device message and use manual entry instead.
5. Test the safe error path by entering `0000000000000`. Confirm it shows a not-found state rather than the Ouma result.
6. Tap **Refresh prices** once on the known product. Confirm the UI stays responsive and retains explicit retailer availability rows.
7. Optional: use the browser menu to add PriceCheck to the Home Screen and reopen it.

## Report back

Please report the phone model, browser, whether camera permission was offered, the scanned or entered barcode, and any mismatch from the expected result. Do not report or share any provider credentials.
