import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Grocery price comparison and ingredient score", description: "Compare available retailer offers and see a transparent ingredient score when product data exists.", robots: { index: false, follow: false } };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
