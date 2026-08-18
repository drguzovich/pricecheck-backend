# Retailer Access Findings

On 18 August 2026, Pick n Pay’s public grocery site rendered a customer-facing product catalogue and stated that local availability and pricing depend on delivery details. The site presented a product search field and product cards with prices in a normal browser session. No official, documented product API credentials or approved server-to-server endpoint were identified during this review.

The PriceCheck backend therefore keeps Pick n Pay behind the `PNP_PRODUCT_LOOKUP_URL` configuration boundary. It can consume an operator-approved product-data provider without changing the public comparison contract. A public-catalogue fallback exists behind `PNP_PUBLIC_CATALOGUE_ENABLED=true`, but should not be enabled until a real barcode can be validated against the site in the deployment environment. The service does not attempt to bypass access controls or site protections.

On the same date, a normal browser session resolved the Woolworths Ouma Rusks URL and exposed the product-page title `Rusks: Ouma Buttermilk, 500g | Woolworths.co.za`. The browser extraction did not expose a reliable visible price in that session. The service must therefore continue to expose stale-cache status rather than claim that a browser title alone proves a current price.
