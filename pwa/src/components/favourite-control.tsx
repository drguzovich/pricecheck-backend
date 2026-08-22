"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { isGuestFavourite, toggleGuestFavourite } from "@/lib/guest-data";
import { addCloudFavourite, cloudFavourites, removeCloudFavourite } from "@/lib/user-api";

export function FavouriteControl({ barcode, productName }: { barcode: string; productName: string }) {
  const { status } = useSession();
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (status === "authenticated") {
      cloudFavourites().then(({ favourites }) => setSaved(favourites.some((item) => item.barcode === barcode))).catch(() => setMessage("Could not check your saved products."));
    } else if (status === "unauthenticated") setSaved(isGuestFavourite(barcode));
  }, [barcode, status]);
  const toggle = async () => {
    setBusy(true); setMessage("");
    try {
      if (status === "authenticated") {
        if (saved) await removeCloudFavourite(barcode); else await addCloudFavourite(barcode, productName);
        setSaved(!saved);
      } else {
        const next = toggleGuestFavourite({ barcode, productName, addedAt: new Date().toISOString() });
        setSaved(next);
        setMessage(next ? "Saved on this device. Sign in later to keep it across devices." : "Removed from this device.");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not update saved products."); }
    finally { setBusy(false); }
  };
  return <span className="favourite-control"><button className="icon-button" type="button" onClick={toggle} disabled={busy} aria-pressed={saved} aria-label={saved ? "Remove saved product" : "Save product"}>{saved ? "♥" : "♡"}</button>{message && <small role="status">{message}</small>}</span>;
}
