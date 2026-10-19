import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "About PriceCheck grocery price comparison", description: "How PriceCheck compares South African grocery prices and explains ingredient information." };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
