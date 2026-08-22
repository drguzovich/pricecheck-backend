import Link from "next/link";
import { InstallButton } from "@/components/install-button";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="PriceCheck home">
        <span className="brand-mark">P</span>
        <span>PriceCheck</span>
      </Link>
      <nav className="main-nav" aria-label="Main navigation">
        <Link href="/search">Search</Link>
        <Link href="/scan">Scan</Link>
        <Link href="/account">Account</Link>
        <InstallButton />
      </nav>
    </header>
  );
}
