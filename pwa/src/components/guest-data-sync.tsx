"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { clearGuestData, guestDataPayload } from "@/lib/guest-data";
import { migrateGuestData } from "@/lib/user-api";

function payloadFingerprint(payload: ReturnType<typeof guestDataPayload>) {
  return [
    payload.clientId,
    ...payload.scans.map((scan) => `s:${scan.id}`),
    ...payload.favourites.map((favourite) => `f:${favourite.id}`),
  ].join("|");
}

export function GuestDataSync() {
  const { data: session, status } = useSession();
  const attempted = useRef(false);
  const [error, setError] = useState("");

  const sync = useCallback(async () => {
    if (status !== "authenticated") return;
    const payload = guestDataPayload();
    if (!payload.scans.length && !payload.favourites.length) {
      attempted.current = true;
      setError("");
      return;
    }
    const accountId = (session?.user as { id?: string } | undefined)?.id || "account";
    const markerKey = `pricecheck-guest-migration:${accountId}`;
    const fingerprint = payloadFingerprint(payload);
    if (window.localStorage.getItem(markerKey) === fingerprint) {
      clearGuestData();
      attempted.current = true;
      setError("");
      return;
    }
    attempted.current = true;
    setError("");
    try {
      await migrateGuestData();
      // Only a confirmed backend response marks this payload synced or clears it.
      window.localStorage.setItem(markerKey, fingerprint);
      clearGuestData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We could not sync your on-device history yet.");
      attempted.current = false;
    }
  }, [session?.user, status]);

  useEffect(() => {
    if (status === "authenticated" && !attempted.current) void sync();
    if (status !== "authenticated") {
      attempted.current = false;
      setError("");
    }
  }, [status, sync]);

  if (!error) return null;
  return <aside className="sync-status inline-error" role="status">
    <span>Your on-device history has not synced. {error}</span>
    <button className="button button-secondary" type="button" onClick={() => void sync()}>Retry sync</button>
  </aside>;
}
