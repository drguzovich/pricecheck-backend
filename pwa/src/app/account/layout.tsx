import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Your PriceCheck account", description: "Manage your PriceCheck account and optional cross-device sync.", robots: { index: false, follow: false } };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
