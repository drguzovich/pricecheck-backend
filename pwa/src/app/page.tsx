import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { RecentSearches } from "@/components/recent-searches";
import { CoverageStatus } from "@/components/coverage-status";
import { SearchHome } from "@/components/search-home";

export default function HomePage() {
  return (
    <main className="app-shell">
      <SiteHeader />
      <section className="home-hero">
        <div className="home-hero-copy">
          <span className="eyebrow">South African grocery comparison</span>
          <h1>Check a price before you shop.</h1>
          <p>Search the catalogue or scan the barcode to compare available retailer prices for the exact product in your hand.</p>
          <SearchHome />
          <p className="home-trust-note">Exact barcode matching · Available retailers only · No similar-product substitutions</p>
        </div>
      </section>
      <CoverageStatus />
      <section className="section-block recent-section">
        <div className="section-heading"><div><span className="eyebrow">Your device</span><h2>Recent searches</h2></div><Link href="/search">Search catalogue</Link></div>
        <RecentSearches />
      </section>
    </main>
  );
}
