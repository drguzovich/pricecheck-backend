import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { publicSiteOrigin } from "@/site-config";

const inter = Inter({ subsets: ["latin"], display: "swap" });
const origin = publicSiteOrigin();

export const metadata: Metadata = {
  ...(origin ? { metadataBase: new URL(origin) } : {}),
  title: { default: "TrolleyWise | Compare South African grocery prices", template: "%s | TrolleyWise" },
  description: "Scan or search groceries, compare available South African retailer prices, and explore ingredient information. No account required.",
  keywords: ["grocery prices", "South Africa", "barcode comparison", "TrolleyWise", "product ingredients"],
  manifest: "/manifest.json",
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon-192.png" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "TrolleyWise" },
  openGraph: {
    title: "TrolleyWise — shop with confidence",
    description: "Compare available grocery prices and ingredient information across South African retailers.",
    type: "website",
    siteName: "TrolleyWise",
    ...(origin ? { url: origin } : {}),
    images: ["https://files.manuscdn.com/user_upload_by_module/session_file/310519663428995278/BpmFciLCgAzdubki.png"],
  },
  twitter: { card: "summary", title: "TrolleyWise — grocery comparison", description: "Scan. Compare. Shop with confidence.", images: ["https://files.manuscdn.com/user_upload_by_module/session_file/310519663428995278/BpmFciLCgAzdubki.png"] },
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
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
