import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Your grocery price alerts", description: "Manage your TrolleyWise target-price notifications.", robots: { index: false, follow: false } };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
