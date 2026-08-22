import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { RecentSearches } from "@/components/recent-searches";
import { CoverageStatus } from "@/components/coverage-status";

export default function HomePage() {
  return (
    <main className="app-shell">
      <SiteHeader />
      <section className="hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">South African grocery comparison</span>
          <h1>Find the best price in seconds.</h1>
          <p>Scan a product barcode or search by name to compare available retailer prices, freshness, and availability in one simple view.</p>
          <div className="hero-actions"><Link className="button button-primary" href="/scan">Scan barcode</Link><Link className="button button-secondary" href="/search">Search by name</Link></div>
          <p className="hero-note">No download required. Add PriceCheck to your home screen when you are ready.</p>
        </div>
        <div className="hero-card" aria-label="How PriceCheck works">
          <div className="hero-card-head"><span>Compare with confidence</span><span className="live-dot">Exact EAN matching</span></div>
          <div className="preview-row"><span><strong>1</strong> Scan or enter a barcode</span><span>Fast lookup</span></div>
          <div className="preview-row"><span><strong>2</strong> Check available retailers</span><span>Live or cached</span></div>
          <div className="preview-row best"><span><strong>3</strong> See the lowest confirmed price</span><b>Best price</b></div>
        </div>
      </section>
      <CoverageStatus />
      <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">Quick start</span><h2>Recent searches</h2></div><Link href="/search">View search</Link></div>
        <RecentSearches />
      </section>
    </main>
  );
}
