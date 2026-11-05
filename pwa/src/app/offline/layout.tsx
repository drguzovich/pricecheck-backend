import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "TrolleyWise offline", description: "Reconnect or revisit a previously cached comparison.", robots: { index: false, follow: false } };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
