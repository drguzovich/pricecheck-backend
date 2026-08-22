import Link from "next/link";

export function SiteFooter() {
  return <footer className="site-footer"><span>PriceCheck · South African grocery comparison</span><nav aria-label="Legal navigation"><Link href="/about">About</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav></footer>;
}
