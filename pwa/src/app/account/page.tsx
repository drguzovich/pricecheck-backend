"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import Link from "next/link";
import { signIn, signOut, useSession } from "next-auth/react";
import type { Session } from "next-auth";
import { accountSummary, type AccountSummary, registerDirectAccount } from "@/lib/user-api";
import { loadAuthReadiness, loadVerificationStatus, performAuthFlow, type AuthReadiness } from "@/lib/auth-flows";
import "@/styles/accounts.css";

type AccountOwner = { key: string };

export default function AccountPage() {
  const { data: session, status } = useSession();
  const identity = (session?.user as { id?: string } | undefined)?.id || session?.user?.email || "";
  const key = status === "authenticated" ? `${status}:${identity}` : status;
  const ownerRef = useRef<AccountOwner>({ key });
  if (ownerRef.current.key !== key) ownerRef.current = { key };
  // Remount personal state synchronously, even when status stays authenticated.
  return <AccountPageContent key={key} session={session} status={status} identity={identity} owner={ownerRef.current} ownerRef={ownerRef} />;
}

function AccountPageContent({ session, status, identity, owner, ownerRef }: { session: Session | null; status: "loading" | "authenticated" | "unauthenticated"; identity: string; owner: AccountOwner; ownerRef: MutableRefObject<AccountOwner> }) {
  const mounted = useRef(false);
  const summaryRequest = useRef(0);
  const configRequest = useRef(0);
  const submittingRef = useRef(false);
  const verificationRequest = useRef(false);
  const current = useCallback(() => mounted.current && ownerRef.current === owner, [owner, ownerRef]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [authConfig, setAuthConfig] = useState<AuthReadiness | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [verification, setVerification] = useState<{ provider: string; emailVerified: boolean } | null>(null);
  const [verificationMessage, setVerificationMessage] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"register" | "signin">("signin");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendingVerification, setSendingVerification] = useState(false);

  const refreshConfiguration = useCallback(async () => {
    if (!current()) return;
    const requestId = ++configRequest.current;
    setConfigFailed(false);
    try {
      const config = await loadAuthReadiness();
      if (current() && configRequest.current === requestId) setAuthConfig(config);
    } catch { if (current() && configRequest.current === requestId) setConfigFailed(true); }
  }, [current]);
  useEffect(() => { void refreshConfiguration(); }, [refreshConfiguration]);
  const refreshSummary = useCallback(async () => {
    if (status !== "authenticated" || !identity || !current()) return;
    const requestId = ++summaryRequest.current;
    setSummaryLoading(true);
    setSummaryError("");
    try {
      const result = await accountSummary();
      if (current() && summaryRequest.current === requestId) setSummary(result.summary);
    } catch (error) {
      if (current() && summaryRequest.current === requestId) setSummaryError(error instanceof Error ? error.message : "Unable to load account totals.");
    } finally { if (current() && summaryRequest.current === requestId) setSummaryLoading(false); }
  }, [current, identity, status]);
  useEffect(() => {
    let cancelled = false;
    if (status !== "authenticated" || !identity) return;
    void refreshSummary();
    void loadVerificationStatus().then((result) => {
      if (!cancelled && current()) setVerification(result);
    }).catch(() => {
      if (!cancelled && current()) setVerificationMessage("Email verification status is temporarily unavailable.");
    });
    return () => { cancelled = true; };
  }, [current, identity, status, refreshSummary]);

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || status !== "unauthenticated" || !authConfig?.authSessionEnabled || submittingRef.current) return;
    submittingRef.current = true;
    setMessage("");
    setSubmitting(true);
    try {
      if (mode === "register") {
        await registerDirectAccount({ displayName, email, password });
        if (!current()) return;
        if (authConfig.emailFlowsEnabled) {
          try { await performAuthFlow("requestVerification", { email }); }
          catch {
            if (current()) {
              setMode("signin");
              setMessage("Your account was created, but the verification request was not confirmed. Sign in, then request a verification link from Account security.");
            }
            return;
          }
        }
      }
      if (!current()) return;
      const result = await signIn("credentials", { redirect: false, email, password, callbackUrl: "/account" });
      if (!current()) return;
      if (!result || result.error) throw new Error("Sign-in did not complete. Check your email and password, or try again later.");
      setPassword("");
      window.location.assign("/account");
    } catch (error) {
      if (current()) setMessage(error instanceof Error ? error.message : "Unable to sign in right now.");
    } finally { submittingRef.current = false; if (current()) setSubmitting(false); }
  }
  async function sendVerification() {
    if (!current() || status !== "authenticated" || !identity || !session?.user?.email || verificationRequest.current) return;
    verificationRequest.current = true;
    setSendingVerification(true);
    setVerificationMessage("");
    try {
      const response = await performAuthFlow("requestVerification", { email: session.user.email });
      if (current()) setVerificationMessage(response.message || "Request received.");
    } catch (error) { if (current()) setVerificationMessage(error instanceof Error ? error.message : "Unable to request verification."); }
    finally { verificationRequest.current = false; if (current()) setSendingVerification(false); }
  }
  async function changeSession(action: "google" | "signout") {
    if (!current()) return;
    try {
      if (action === "signout") await signOut({ callbackUrl: "/account" });
      else await signIn("google", { callbackUrl: "/account" });
    } catch {
      if (current()) {
        if (action === "signout") setSummaryError("Sign-out did not complete. Please try again.");
        else setMessage("Google sign-in did not complete. Please try again.");
      }
    }
  }
  const sessionReady = Boolean(authConfig?.authSessionEnabled);
  const googleReady = Boolean(authConfig?.googleAuthEnabled && sessionReady);
  const accountLoading = status === "loading" || (!authConfig && !configFailed);

  return <main className="app-shell account-page tw-accounts">
    <Link className="back-link" href="/">‹ Back to shopping</Link>
    <section className="account-hero">
      <span className="eyebrow">Your TrolleyWise</span>
      <h1>{status === "authenticated" ? `Welcome, ${session?.user?.name?.split(" ")[0] || "shopper"}` : "Your everyday shop, saved"}</h1>
      <p>{status === "authenticated" ? "Your cloud scans, favourites and alerts belong to your account." : "Shop as a guest. Sign in when you want your scans and favourites across devices."}</p>
    </section>
    {accountLoading && <section className="account-card tw-loading" aria-busy="true" aria-label="Loading account"><span className="skeleton skeleton-line skeleton-line-medium" /><p>Loading account options…</p></section>}
    {configFailed && <section className="tw-notice" role="status"><p>Account configuration could not be loaded. Guest shopping and the isolated demo remain available.</p><button className="button button-secondary" onClick={() => void refreshConfiguration()}>Retry account options</button></section>}
    {!accountLoading && status === "authenticated" && <>
      <section className="account-card">
        <div className="account-identity"><span className="avatar" aria-hidden="true">{session?.user?.name?.slice(0, 1).toUpperCase() || "T"}</span><div><strong>{session?.user?.name || "TrolleyWise member"}</strong><small>{session?.user?.email}</small></div></div>
        <button className="button button-secondary" onClick={() => void changeSession("signout")}>Sign out</button>
      </section>
      <section className="tw-totals" aria-label="Cloud account totals" aria-busy={summaryLoading}>
        <div className="tw-section-heading"><h2>In your account</h2><button className="button button-secondary" onClick={() => void refreshSummary()} disabled={summaryLoading}>{summaryLoading ? "Refreshing…" : "Refresh totals"}</button></div>
        {summary ? <div className="account-stats"><div><strong>{summary.scanCount}</strong><span>Cloud scans</span></div><div><strong>{summary.favouritesCount}</strong><span>Favourites</span></div><div><strong>{summary.alertsCount}</strong><span>Active alerts</span></div></div> : summaryLoading ? <p>Loading your actual account totals…</p> : <p>Account totals are not available right now.</p>}
        {summaryError && <p className="inline-error" role="status">{summaryError}</p>}
        <p className="tw-helper">Guest data is only cleared after cloud sync succeeds. Refresh totals after a sync retry.</p>
      </section>
      <section className="account-links"><Link href="/history">Scan history <span aria-hidden="true">›</span></Link><Link href="/favourites">Favourite products <span aria-hidden="true">›</span></Link><Link href="/alerts">Price alerts <span aria-hidden="true">›</span></Link></section>
      <section className="tw-notice"><h2>Account security</h2>
        {verification?.provider === "password" && <><p><strong>{verification.emailVerified ? "Email verified" : "Email not verified yet"}</strong></p>{!verification.emailVerified && <button className="button button-secondary" onClick={() => void sendVerification()} disabled={sendingVerification || !authConfig?.emailFlowsEnabled}>{sendingVerification ? "Requesting…" : "Send verification link"}</button>}</>}
        {verification?.provider === "google" && <p>Your Google account manages its own password. TrolleyWise password-reset links apply only to email/password accounts.</p>}
        <p className="tw-helper">{authConfig?.emailMessage}</p>
        {verificationMessage && <p role="status">{verificationMessage}</p>}
        {verification?.provider !== "google" && <Link className="tw-text-link" href="/account/forgot-password">Reset your password</Link>}
      </section>
    </>}
    {!accountLoading && status === "unauthenticated" && <section className="account-card account-auth-card">
      <div className="account-auth-copy"><strong>Guest mode is active</strong><p>Guest scans and favourites stay on this device. After real sign-in, successful sync moves them into your private cloud account.</p></div>
      {authConfig?.sessionMessage && <p className="tw-helper" role="status">{authConfig.sessionMessage}</p>}
      <button className="button button-secondary" disabled={!googleReady} onClick={() => void changeSession("google")}>Continue with Google</button>
      <small className="tw-helper">{authConfig?.googleMessage || "Google sign-in readiness could not be checked."}</small>
      <div className="account-auth-tabs" role="group" aria-label="Account actions">
        <button type="button" className="button button-secondary" aria-pressed={mode === "signin"} onClick={() => { setMode("signin"); setMessage(""); }}>Sign in</button>
        <button type="button" className="button button-secondary" aria-pressed={mode === "register"} onClick={() => { setMode("register"); setMessage(""); }}>Create account</button>
      </div>
      <form className="account-auth-form" onSubmit={submitAccount} aria-busy={submitting}>
        {mode === "register" && <label><span>Your name</span><input disabled={!sessionReady || submitting} value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" minLength={2} maxLength={80} required /></label>}
        <label><span>Email address</span><input disabled={!sessionReady || submitting} value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" maxLength={320} required /></label>
        <label><span>Password</span><input disabled={!sessionReady || submitting} value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 10 : undefined} maxLength={128} required /></label>
        {mode === "register" && <small>Use 10 to 128 characters. {authConfig?.emailFlowsEnabled ? "A verification link can be requested after registration." : "Email verification and password reset are not available right now."}</small>}
        <button className="button button-primary" type="submit" disabled={submitting || !sessionReady}>{submitting ? "Please wait…" : mode === "register" ? "Create free account" : "Sign in"}</button>
      </form>
      {message && <p className="inline-error" role="status">{message}</p>}
      <Link className="tw-text-link" href="/account/forgot-password">Forgot your password?</Link>
      <p className="tw-helper">{authConfig?.emailMessage}</p>
      <Link className="button button-secondary" href="/history">View on-device history</Link>
    </section>}
    <section className="tw-demo-entry"><div><span className="eyebrow">No account needed</span><h2>Have a look around</h2><p>Try an isolated on-device watchlist with labelled fixtures. No real prices, health data or cloud account access.</p></div><Link className="button button-secondary" href="/demo" prefetch={false}>Try demo</Link></section>
  </main>;
}
