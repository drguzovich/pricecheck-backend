import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Search grocery prices in South Africa", description: "Search by product name or barcode and compare available South African retailer prices." };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
