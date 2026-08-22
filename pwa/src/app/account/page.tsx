"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { signIn, signOut, useSession } from "next-auth/react";
import { accountSummary, AccountSummary } from "@/lib/user-api";

export default function AccountPage() {
  const { data: session, status } = useSession();
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { fetch("/api/auth-config").then((res) => res.json()).then((data) => setGoogleEnabled(Boolean(data.googleAuthEnabled))).catch(() => setGoogleEnabled(false)); }, []);
  useEffect(() => { if (status === "authenticated") accountSummary().then((data) => setSummary(data.summary)).catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load account.")); }, [status]);
  return <main className="app-shell account-page">
    <section className="account-hero"><span className="eyebrow">Your PriceCheck</span><h1>{status === "authenticated" ? `Welcome, ${session.user?.name?.split(" ")[0] || "shopper"}` : "Keep your price checks"}</h1><p>{status === "authenticated" ? "Your scans, favourites, and alerts are private to your account." : "Use PriceCheck as a guest, then sign in when you want your history across devices."}</p></section>
    {status === "loading" && <div className="account-card skeleton-card" aria-label="Loading account" />}
    {status === "authenticated" && <><section className="account-card"><div className="account-identity"><span className="avatar">{session.user?.name?.slice(0, 1).toUpperCase() || "P"}</span><div><strong>{session.user?.name || "PriceCheck member"}</strong><small>{session.user?.email}</small></div></div><button className="button button-secondary" onClick={() => signOut({ callbackUrl: "/account" })}>Sign out</button></section><section className="account-stats"><div><strong>{summary?.scanCount ?? "…"}</strong><span>Cloud scans</span></div><div><strong>{summary?.favouritesCount ?? "…"}</strong><span>Favourites</span></div><div><strong>{summary?.alertsCount ?? "…"}</strong><span>Active alerts</span></div></section><section className="account-links"><Link href="/history">Scan history <span>›</span></Link><Link href="/favourites">Favourite products <span>›</span></Link><Link href="/alerts">Price alerts <span>›</span></Link></section></>}
    {status === "unauthenticated" && <section className="account-card"><strong>Guest mode is active</strong><p>Guest scans and favourites stay on this device. Signing in migrates them to your private account.</p>{googleEnabled ? <button className="button button-primary" onClick={() => signIn("google", { callbackUrl: "/account" })}>Continue with Google</button> : <><p className="muted-copy">Google sign-in will appear when the approved OAuth credentials are configured for the release environment.</p><Link className="button button-secondary" href="/history">View on-device history</Link></>}</section>}
    {message && <p className="inline-error" role="status">{message}</p>}
  </main>;
}
