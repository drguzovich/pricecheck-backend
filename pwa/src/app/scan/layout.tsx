import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Scan a barcode and compare grocery prices", description: "Use your camera or enter a barcode to compare retailer prices and available ingredient information." };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
