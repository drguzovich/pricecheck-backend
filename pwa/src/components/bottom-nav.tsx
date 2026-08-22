"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Home", icon: "⌂" },
  { href: "/search", label: "Search", icon: "⌕" },
  { href: "/scan", label: "Scan", icon: "▣" },
  { href: "/history", label: "History", icon: "◷" },
  { href: "/account", label: "Account", icon: "◉" },
];

export function BottomNav() {
  const pathname = usePathname();
  return <nav className="bottom-nav" aria-label="Mobile navigation">{links.map((link) => {
    const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
    return <Link key={link.href} href={link.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}><span aria-hidden="true">{link.icon}</span><small>{link.label}</small></Link>;
  })}</nav>;
}
