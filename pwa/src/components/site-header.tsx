import Link from "next/link";
import { InstallButton } from "@/components/install-button";
import { ScanIcon, SearchIcon } from "@/components/icons";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="PriceCheck home">
        <span className="brand-mark" aria-hidden="true"><span>P</span></span>
        <span>PriceCheck</span>
      </Link>
      <nav className="main-nav" aria-label="Main navigation">
        <Link href="/search"><SearchIcon size={17} /> <span>Search</span></Link>
        <Link href="/scan"><ScanIcon size={17} /> <span>Scan</span></Link>
        <Link href="/account">Account</Link>
        <InstallButton />
      </nav>
    </header>
  );
}
