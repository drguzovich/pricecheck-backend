import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Your favourite grocery products", description: "Revisit saved products and manage price alert targets.", robots: { index: false, follow: false } };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
