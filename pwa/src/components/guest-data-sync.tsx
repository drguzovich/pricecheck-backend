"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { clearGuestData, guestDataPayload } from "@/lib/guest-data";
import { userRequest } from "@/lib/user-api";

function payloadFingerprint(payload: ReturnType<typeof guestDataPayload>) {
  return JSON.stringify({ clientId: payload.clientId, scans: payload.scans, favourites: payload.favourites });
}

export function GuestDataSync() {
  const { data: session, status } = useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempted = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const identity = status === "authenticated" ? (session?.user as { id?: string } | undefined)?.id || session?.user?.email || "" : "";
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const sync = useCallback(async () => {
    if (status !== "authenticated" || !identity || inFlight.current) return;
    const owner = identity;
    const controller = new AbortController();
    inFlight.current = controller;
    attempted.current = owner;
    setBusy(true);
    setError("");
    let timer: number | undefined;
    try {
      const payload = guestDataPayload();
      if (!payload.scans.length && !payload.favourites.length) return;
      const fingerprint = payloadFingerprint(payload);
      timer = window.setTimeout(() => controller.abort(), 35_000);
      // Send exactly the captured data. A second read inside the API helper could race with new guest scans.
      const response = await userRequest<{ summary?: { scanCount?: number; favouritesCount?: number } }>("/users/migrate", {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!Number.isSafeInteger(response.summary?.scanCount) || !Number.isSafeInteger(response.summary?.favouritesCount) || (response.summary?.scanCount ?? -1) < 0 || (response.summary?.favouritesCount ?? -1) < 0) throw new Error("The service did not confirm the migration. Your device data is still available.");
      if (!mounted.current || controller.signal.aborted || identityRef.current !== owner) return;
      // Never clear scans or favourites added while the captured payload was in flight.
      if (payloadFingerprint(guestDataPayload()) !== fingerprint) {
        setError("The first items synced, but new device items arrived during sync. Retry to include them. All device items have been kept.");
        return;
      }
      // Always ask the authenticated backend, even when an old browser marker exists.
      // Stable guest record IDs let the backend safely deduplicate retries.
      const accountId = (session?.user as { id?: string } | undefined)?.id;
      if (accountId) window.localStorage.setItem(`trolleywise-guest-migration:${accountId}`, fingerprint);
      clearGuestData();
      window.dispatchEvent(new Event("trolleywise-favourites-changed"));
    } catch (caught) {
      if (mounted.current && inFlight.current === controller && identityRef.current === owner) setError(caught instanceof Error && caught.name === "AbortError" ? "Sync timed out. Your device data is still here. Please retry." : caught instanceof Error ? caught.message : "Could not sync your device history and favourites. They have been kept.");
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      if (inFlight.current === controller) {
        inFlight.current = null;
        if (mounted.current && identityRef.current === owner) setBusy(false);
      }
    }
  }, [identity, session?.user, status]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; inFlight.current?.abort(); inFlight.current = null; }; }, []);
  useEffect(() => {
    if (status !== "authenticated") {
      inFlight.current?.abort();
      inFlight.current = null;
      attempted.current = null;
      setBusy(false);
      setError("");
      return;
    }
    if (identity && attempted.current !== identity) {
      inFlight.current?.abort();
      inFlight.current = null;
      void sync();
    }
  }, [identity, status, sync]);

  if (!busy && !error) return null;
  return <aside className={`sync-status${error ? " inline-error" : ""}`} role="status">
    <span>{busy ? "Syncing your device history and favourites…" : `Some on-device history or favourites have not synced. ${error}`}</span>
    {error && <button className="button button-secondary" style={{ minHeight: 44 }} type="button" disabled={busy} onClick={() => void sync()}>Retry sync</button>}
  </aside>;
}
