"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { isGuestFavourite, readGuestFavourites, toggleGuestFavourite } from "@/lib/guest-data";
import { addCloudFavourite, cloudFavourites, removeCloudFavourite } from "@/lib/user-api";
import { StarIcon } from "@/components/icons";

export function FavouriteControl({ barcode, productName }: { barcode: string; productName: string }) {
  const { data: session, status } = useSession();
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const loadVersion = useRef(0);
  const saving = useRef(false);
  const mounted = useRef(false);
  const context = `${barcode}:${status}:${session?.user?.email || (session?.user as { id?: string })?.id || ""}`;
  const contextRef = useRef(context);
  contextRef.current = context;

  const check = useCallback(async () => {
    const version = ++loadVersion.current;
    setReady(false);
    setCheckFailed(false);
    try {
      if (status === "authenticated") {
        const result = await cloudFavourites();
        if (!Array.isArray(result.favourites)) throw new Error("Your saved products could not be checked.");
        if (mounted.current && version === loadVersion.current && contextRef.current === context) { setSaved(result.favourites.some((item) => item.barcode === barcode)); setReady(true); }
      } else if (status === "unauthenticated") {
        setSaved(isGuestFavourite(barcode));
        setReady(true);
      }
    } catch {
      if (mounted.current && version === loadVersion.current) { setCheckFailed(true); setMessage("Could not check your saved products. Retry before making changes."); }
    }
  }, [barcode, status, context]);

  useEffect(() => {
    mounted.current = true;
    setSaved(false);
    setMessage("");
    setBusy(false);
    saving.current = false;
    void check();
    const refresh = () => { if (!saving.current) void check(); };
    window.addEventListener("pricecheck-guest-data", refresh);
    window.addEventListener("trolleywise-guest-data", refresh);
    window.addEventListener("trolleywise-favourites-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      mounted.current = false;
      loadVersion.current += 1;
      window.removeEventListener("pricecheck-guest-data", refresh);
      window.removeEventListener("trolleywise-guest-data", refresh);
      window.removeEventListener("trolleywise-favourites-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [check]);

  const toggle = async () => {
    if (!ready || saving.current || status === "loading") return;
    const owner = context;
    const nextSaved = !saved;
    saving.current = true;
    loadVersion.current += 1;
    setBusy(true);
    setMessage("");
    try {
      if (status === "authenticated") {
        if (saved) {
          const result = await removeCloudFavourite(barcode);
          if (result.removed !== true) throw new Error("Removal was not confirmed. Please retry.");
        } else {
          const result = await addCloudFavourite(barcode, productName || barcode);
          if (result.favourite?.barcode !== barcode) throw new Error("The save was not confirmed. Please retry.");
        }
        if (mounted.current && contextRef.current === owner) { setSaved(nextSaved); setMessage(nextSaved ? "Saved to your account." : "Removed from your account."); }
        window.dispatchEvent(new Event("trolleywise-favourites-changed"));
      } else {
        if (!isGuestFavourite(barcode) && readGuestFavourites().length >= 100) throw new Error("You have 100 favourites on this device. Remove one before saving more.");
        const next = toggleGuestFavourite({ barcode, productName: productName || barcode, addedAt: new Date().toISOString() });
        if (isGuestFavourite(barcode) !== next) throw new Error("Device storage did not confirm this change.");
        setSaved(next);
        setMessage(next ? "Saved on this device. Sign in to sync across devices." : "Removed from this device.");
      }
    } catch (error) {
      if (mounted.current && contextRef.current === owner) setMessage(error instanceof Error ? error.message : "Could not update your saved products. Please retry.");
    } finally {
      if (mounted.current && contextRef.current === owner) { saving.current = false; setBusy(false); }
    }
  };

  return <span className="favourite-control">
    <button className="icon-button favourite-button" style={{ minWidth: 44, minHeight: 44 }} type="button" onClick={() => void toggle()} disabled={busy || !ready || status === "loading"} aria-busy={busy || (!ready && !checkFailed)} aria-pressed={saved} aria-label={busy ? "Updating saved product" : saved ? "Remove saved product" : "Save product"}><StarIcon size={21} filled={saved} /></button>
    {message && <small role="status">{message}</small>}
    {checkFailed && <button className="button button-secondary" style={{ minHeight: 44 }} type="button" onClick={() => { setMessage(""); void check(); }}>Retry favourites</button>}
  </span>;
}
