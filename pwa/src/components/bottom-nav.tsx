"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountIcon, HistoryIcon, HomeIcon, ScanIcon } from "@/components/icons";

const links = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/scan", label: "Scan", icon: ScanIcon },
  { href: "/history", label: "History", icon: HistoryIcon },
  { href: "/account", label: "Account", icon: AccountIcon },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="bottom-nav" aria-label="Mobile navigation">
      {links.map((link) => {
        const active = link.href === "/" ? pathname === "/" || pathname.startsWith("/search") || pathname.startsWith("/result") : pathname.startsWith(link.href);
        const Icon = link.icon;
        return (
          <Link key={link.href} href={link.href} className={`bottom-nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
            <Icon size={21} />
            <small>{link.label}</small>
          </Link>
        );
      })}
    </nav>
  );
}
