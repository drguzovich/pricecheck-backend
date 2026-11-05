"use client";

import { SessionProvider } from "next-auth/react";
import { usePathname } from "next/navigation";
import { GuestDataSync } from "@/components/guest-data-sync";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineBanner } from "@/components/offline-banner";
import { SiteFooter } from "@/components/site-footer";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/demo" || pathname.startsWith("/demo/")) return <>{children}</>;
  return <SessionProvider>
    <ServiceWorkerRegister />
    <GuestDataSync />
    <OfflineBanner />
    {children}
    <SiteFooter />
    <BottomNav />
  </SessionProvider>;
}
