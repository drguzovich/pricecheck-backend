import Link from "next/link";

export default function AboutPage() {
  return <main className="app-shell legal-page"><span className="eyebrow">About PriceCheck</span><h1>Compare the groceries you actually buy</h1><p>PriceCheck is a South African grocery research tool. Scan a packaged product, review exact-barcode retailer availability, and save the items you care about.</p><h2>How comparison works</h2><p>We begin with the barcode, not a fuzzy title match. This protects shoppers from comparing a small pack with a different-size product. When a retailer does not publish an exact listing, the result explains the gap rather than making up a substitute price.</p><h2>What is improving</h2><p>Catalogue coverage grows through verified product requests and approved retailer data. Store-specific retailers such as SPAR require a branch-level source before a reliable national comparison can be shown.</p><Link className="button button-primary" href="/scan">Try a barcode scan</Link></main>;
}
