"use client";

import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { clearGuestData, guestDataPayload } from "@/lib/guest-data";
import { migrateGuestData } from "@/lib/user-api";

export function GuestDataSync() {
  const { status } = useSession();
  const attempted = useRef(false);
  useEffect(() => {
    if (status !== "authenticated" || attempted.current) return;
    const payload = guestDataPayload();
    if (!payload.scans.length && !payload.favourites.length) { attempted.current = true; return; }
    attempted.current = true;
    migrateGuestData().then(() => clearGuestData()).catch(() => { attempted.current = false; });
  }, [status]);
  return null;
}
