import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { AuthProvider } from "@/components/auth-provider";
import { GuestDataSync } from "@/components/guest-data-sync";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineBanner } from "@/components/offline-banner";
import { SiteFooter } from "@/components/site-footer";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "PriceCheck | Compare South African grocery prices",
  description: "Find and compare grocery prices across South African retailers.",
  manifest: "/manifest.json",
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon.svg" },
};

export const viewport: Viewport = { themeColor: "#00BFA5", colorScheme: "dark" };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          <ServiceWorkerRegister />
          <GuestDataSync />
          <OfflineBanner />
          {children}
          <SiteFooter />
          <BottomNav />
        </AuthProvider>
      </body>
    </html>
  );
}
