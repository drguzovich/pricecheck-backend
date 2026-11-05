import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "About TrolleyWise grocery price comparison", description: "How TrolleyWise compares South African grocery prices and explains ingredient information." };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
