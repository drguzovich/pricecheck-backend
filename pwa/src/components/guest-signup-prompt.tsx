"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { readGuestScanCount } from "@/lib/guest-data";

export function GuestSignupPrompt() {
  const { status } = useSession();
  const [scanCount, setScanCount] = useState(0);

  useEffect(() => {
    const sync = () => setScanCount(readGuestScanCount());
    sync();
    window.addEventListener("pricecheck-guest-data", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("pricecheck-guest-data", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  if (status !== "unauthenticated" || scanCount < 3) return null;
  return <aside className="guest-signup-prompt"><strong>Save your history across devices?</strong><p>Create a free account to sync your scans, favourites, and alerts.</p><Link className="button button-primary" href="/account">Create free account</Link></aside>;
}
