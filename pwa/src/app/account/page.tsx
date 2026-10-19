"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { signIn, signOut, useSession } from "next-auth/react";
import { accountSummary, AccountSummary, registerDirectAccount } from "@/lib/user-api";

type AuthConfig = {
  authSessionEnabled: boolean;
  googleAuthEnabled: boolean;
  googleMessage: string | null;
  sessionMessage: string | null;
};

export default function AccountPage() {
  const { data: session, status } = useSession();
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"register" | "signin">("register");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    fetch("/api/auth-config", { cache: "no-store" })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error("configuration unavailable")))
      .then((data: AuthConfig) => setAuthConfig(data))
      .catch(() => setAuthConfig({
        authSessionEnabled: false,
        googleAuthEnabled: false,
        googleMessage: "Google sign-in is unavailable while account configuration cannot be loaded.",
        sessionMessage: "Account sign-in is temporarily unavailable.",
      }));
  }, []);
  useEffect(() => { if (status === "authenticated") accountSummary().then((data) => setSummary(data.summary)).catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load account.")); }, [status]);
  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authConfig?.authSessionEnabled) {
      setMessage(authConfig?.sessionMessage || "Account sign-in is unavailable.");
      return;
    }
    setMessage("");
    setSubmitting(true);
    try {
      if (mode === "register") await registerDirectAccount({ displayName, email, password });
      const result = await signIn("credentials", { redirect: false, email, password, callbackUrl: "/account" });
      if (!result || result.error) throw new Error(mode === "register" ? "Account created, but sign-in did not complete. Please sign in." : "Email or password is incorrect.");
      window.location.assign("/account");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to sign in right now.");
    } finally {
      setSubmitting(false);
    }
  }
  const sessionReady = Boolean(authConfig?.authSessionEnabled);
  const googleReady = Boolean(authConfig?.googleAuthEnabled && sessionReady);
  const accountLoading = status === "loading" || authConfig === null;

  return <main className="app-shell account-page">
    <section className="account-hero"><span className="eyebrow">Your PriceCheck</span><h1>{status === "authenticated" ? `Welcome, ${session.user?.name?.split(" ")[0] || "shopper"}` : "Keep your price checks"}</h1><p>{status === "authenticated" ? "Your scans, favourites, and alerts are private to your account." : "Use PriceCheck as a guest, then sign in when you want your history across devices."}</p></section>
    {accountLoading && <><div className="account-card skeleton-card" aria-busy="true" aria-label="Loading account" /><section className="account-stats skeleton-card" aria-hidden="true" /></>}
    {!accountLoading && status === "authenticated" && <><section className="account-card"><div className="account-identity"><span className="avatar">{session.user?.name?.slice(0, 1).toUpperCase() || "P"}</span><div><strong>{session.user?.name || "PriceCheck member"}</strong><small>{session.user?.email}</small></div></div><button className="button button-secondary" onClick={() => signOut({ callbackUrl: "/account" })}>Sign out</button></section><section className="account-stats" aria-busy={!summary}>{summary ? <><div><strong>{summary.scanCount}</strong><span>Cloud scans</span></div><div><strong>{summary.favouritesCount}</strong><span>Favourites</span></div><div><strong>{summary.alertsCount}</strong><span>Active alerts</span></div></> : <div className="skeleton-card">Loading account totals…</div>}</section><section className="account-links"><Link href="/history">Scan history <span>›</span></Link><Link href="/favourites">Favourite products <span>›</span></Link><Link href="/alerts">Price alerts <span>›</span></Link></section></>}
    {!accountLoading && status === "unauthenticated" && <section className="account-card account-auth-card"><div className="account-auth-copy"><strong>Guest mode is active</strong><p>Guest scans and favourites stay on this device. Creating an account securely migrates them to your private account.</p></div>{!sessionReady && <p className="inline-error" role="status">{authConfig?.sessionMessage}</p>}<button className="button button-secondary" disabled={!googleReady} title={!googleReady ? authConfig?.googleMessage || authConfig?.sessionMessage || "Google sign-in is unavailable." : undefined} onClick={() => signIn("google", { callbackUrl: "/account" })}>Continue with Google</button><small>{authConfig?.googleMessage || "Google sign-in is available."}</small><div className="account-auth-tabs" role="tablist" aria-label="Account actions"><button type="button" className="button button-secondary" disabled={!sessionReady} aria-pressed={mode === "register"} onClick={() => { setMode("register"); setMessage(""); }}>Create account</button><button type="button" className="button button-secondary" disabled={!sessionReady} aria-pressed={mode === "signin"} onClick={() => { setMode("signin"); setMessage(""); }}>Sign in</button></div><form className="account-auth-form" onSubmit={submitAccount}>{mode === "register" && <label><span>Your name</span><input disabled={!sessionReady} value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" minLength={2} maxLength={80} required /></label>}<label><span>Email address</span><input disabled={!sessionReady} value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required /></label><label><span>Password</span><input disabled={!sessionReady} value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={10} maxLength={128} required /></label>{mode === "register" && <small>Use at least 10 characters. Password reset will be available when email delivery is enabled.</small>}<button className="button button-primary" type="submit" disabled={submitting || !sessionReady}>{submitting ? "Please wait…" : mode === "register" ? "Create free account" : "Sign in"}</button></form><Link className="button button-secondary" href="/history">View on-device history</Link></section>}
    {message && <p className="inline-error" role="status">{message}</p>}
  </main>;
}
