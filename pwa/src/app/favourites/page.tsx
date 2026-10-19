"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { readGuestFavourites, type GuestFavourite } from "@/lib/guest-data";
import { cloudFavourites, type StoredFavourite } from "@/lib/user-api";

type Favourite = GuestFavourite | StoredFavourite;
const productName = (favourite: Favourite) => "product_name" in favourite ? favourite.product_name : favourite.productName;

export default function FavouritesPage() {
  const { status } = useSession();
  const [favourites, setFavourites] = useState<Favourite[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (status === "loading") { setLoading(true); return; }
    if (status === "authenticated") {
      setLoading(true);
      cloudFavourites().then((data) => { if (!cancelled) setFavourites(data.favourites); }).catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "Unable to load favourites."); }).finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
    const syncGuestFavourites = () => { if (!cancelled) setFavourites(readGuestFavourites()); };
    syncGuestFavourites();
    setLoading(false);
    window.addEventListener("pricecheck-guest-data", syncGuestFavourites);
    window.addEventListener("storage", syncGuestFavourites);
    return () => { cancelled = true; window.removeEventListener("pricecheck-guest-data", syncGuestFavourites); window.removeEventListener("storage", syncGuestFavourites); };
  }, [status]);

  return <main className="app-shell list-page"><span className="eyebrow">Saved products</span><h1>Favourites</h1><p className="muted-copy">{status === "authenticated" ? "Products saved to your private account." : "Products saved on this device."}</p>{loading ? <div className="history-list" aria-busy="true"><div className="skeleton-card">Loading favourites…</div><div className="skeleton-card" /></div> : !favourites.length ? <div className="empty-state"><span>♡</span><strong>No favourites yet.</strong><p>Save a product on its price result page to follow it here.</p><Link className="button button-primary" href="/search">Find a product</Link></div> : <div className="history-list">{favourites.map((favourite) => <article className="favourite-item" key={favourite.barcode}><Link href={`/result?barcode=${favourite.barcode}`}><span className="product-glyph" aria-label="Starred product">★</span><span><strong>{productName(favourite)}</strong><small>Barcode {favourite.barcode}</small></span><span>›</span></Link><Link className="button button-secondary" href={`/result?barcode=${favourite.barcode}&alert=1`}>Set price alert</Link></article>)}</div>}{message && <p className="inline-error" role="status">{message}</p>}</main>;
}
