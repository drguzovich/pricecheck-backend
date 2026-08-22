"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { readGuestFavourites, type GuestFavourite } from "@/lib/guest-data";
import { cloudFavourites, type StoredFavourite } from "@/lib/user-api";

type Favourite = GuestFavourite | StoredFavourite;
const productName = (favourite: Favourite) => "product_name" in favourite ? favourite.product_name : favourite.productName;

export default function FavouritesPage() {
  const { status } = useSession(); const [favourites, setFavourites] = useState<Favourite[]>([]); const [message, setMessage] = useState("");
  useEffect(() => { if (status === "authenticated") cloudFavourites().then((data) => setFavourites(data.favourites)).catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load favourites.")); else if (status === "unauthenticated") setFavourites(readGuestFavourites()); }, [status]);
  return <main className="app-shell list-page"><span className="eyebrow">Saved products</span><h1>Favourites</h1><p className="muted-copy">{status === "authenticated" ? "Products saved to your private account." : "Products saved on this device."}</p>{!favourites.length && status !== "loading" ? <div className="empty-state"><span>♡</span><strong>Nothing saved yet</strong><p>Save a product on its price result page to follow it here.</p><Link className="button button-primary" href="/search">Find a product</Link></div> : <div className="history-list">{favourites.map((favourite) => <Link key={favourite.barcode} href={`/result?barcode=${favourite.barcode}`}><span className="product-glyph">♥</span><span><strong>{productName(favourite)}</strong><small>Barcode {favourite.barcode}</small></span><span>›</span></Link>)}</div>}{message && <p className="inline-error">{message}</p>}</main>;
}
