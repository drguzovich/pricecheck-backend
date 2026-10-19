import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { AuthProvider } from "@/components/auth-provider";
import { GuestDataSync } from "@/components/guest-data-sync";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineBanner } from "@/components/offline-banner";
import { SiteFooter } from "@/components/site-footer";
import { publicSiteOrigin } from "@/site-config";

const inter = Inter({ subsets: ["latin"], display: "swap" });
const origin = publicSiteOrigin();

export const metadata: Metadata = {
  ...(origin ? { metadataBase: new URL(origin) } : {}),
  title: { default: "PriceCheck | Compare South African grocery prices", template: "%s | PriceCheck" },
  description: "Scan or search groceries, compare available South African retailer prices, and explore ingredient information. No account required.",
  keywords: ["grocery prices", "South Africa", "barcode comparison", "PriceCheck", "product ingredients"],
  manifest: "/manifest.json",
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon-192.png" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "PriceCheck" },
  openGraph: {
    title: "PriceCheck — shop with confidence",
    description: "Compare available grocery prices and ingredient information across South African retailers.",
    type: "website",
    siteName: "PriceCheck",
    ...(origin ? { url: origin } : {}),
    images: ["https://files.manuscdn.com/user_upload_by_module/session_file/310519663428995278/PkJaGAHCpEISzIkE.png"],
  },
  twitter: { card: "summary", title: "PriceCheck — grocery comparison", description: "Scan. Compare. Shop with confidence.", images: ["https://files.manuscdn.com/user_upload_by_module/session_file/310519663428995278/PkJaGAHCpEISzIkE.png"] },
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
