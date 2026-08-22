# Seed Catalogue Research Notes

The 100-item South African grocery seed candidate research ran on 21 August 2026. The raw machine-readable results are retained at `/home/ubuntu/research_sa_grocery_eans.csv` and `/home/ubuntu/research_sa_grocery_eans.json` for seed-list generation. Only `high` confidence exact EAN matches should be added to the seed script. `NOT_FOUND` and variable-weight products must not be guessed or substituted.

| Verified product | EAN | Public source |
|---|---:|---|
| Ouma Buttermilk Rusks Sliced 450g | 6001069600754 | https://www.pnp.co.za/ouma-buttermilk-rusks-sliced-450g/p/000000000000544828_EA |
| Ouma Chunky Buttermilk Rusks 500g | 6001069600822 | https://www.pnp.co.za/ouma-chunky-buttermilk-rusks-500g/p/000000000000544830_EA |
| Albany Superior White Sliced Bread 700g | 6001253010178 | https://www.pnp.co.za/albany-superior-white-sliced-bread-700g/p/000000000000129009_EA |
| Albany Superior Brown Bread 700g | 6001253010185 | https://www.pnp.co.za/albany-superior-sliced-brown-bread-700g/p/000000000000251231_EA |
| Blue Ribbon Classic White Sliced Bread 700g | 6009629181064 | https://www.pnp.co.za/blue-ribbon-classic-white-sliced-bread-700g/p/000000000000254517_EA |
| Coca-Cola Original Taste 2L | 5449000009067 | https://www.woolworths.co.za/prod/_/A-5449000009067 |
| Koo Baked Beans in Tomato Sauce 400g | 6009522310363 | https://www.woolworths.co.za/prod/_/A-6009522310363 |
| Ouma Rusks Bite Size Buttermilk 200g | 6001069602451 | https://www.pnp.co.za/ouma-rusks-bite-size-buttermilk-200g/p/000000000000726839_EA |

> Research result summary: the source returned 80 rows, of which many high-confidence exact EANs were confirmed using public retailer or product-database pages. Some PnP bakery, meat, and produce entries are variable-weight or only expose internal SKU values, so they are explicitly excluded from a fixed-EAN seed catalogue.
