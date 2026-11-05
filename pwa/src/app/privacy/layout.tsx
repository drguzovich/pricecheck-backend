import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "TrolleyWise privacy and data choices", description: "Learn what TrolleyWise stores, how your information is used and how to request deletion." };
export default function RouteLayout({ children }: { children: ReactNode }) { return children; }
