"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { loadAuthReadiness, performAuthFlow, takeLinkToken, type AuthReadiness } from "@/lib/auth-flows";
import "@/styles/accounts.css";

export default function VerifyEmailPage() {
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<AuthReadiness | null>(null);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const tokenRead = useRef(false);
  useEffect(() => {
    if (tokenRead.current) return;
    tokenRead.current = true;
    setToken(takeLinkToken());
    setReady(true);
    loadAuthReadiness().then(setConfig).catch(() => setMessage("Email verification readiness is temporarily unavailable."));
  }, []);
  async function confirm() {
    if (!token || busy || done) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await performAuthFlow("confirmVerification", { token });
      setMessage(result.message || "Your email address is verified.");
      setDone(true);
      setToken("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to verify your email."); }
    finally { setBusy(false); }
  }
  async function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !config?.emailFlowsEnabled) return;
    setBusy(true);
    setMessage("");
    try { setMessage((await performAuthFlow("requestVerification", { email })).message || "Request received."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to request a link."); }
    finally { setBusy(false); }
  }
  return <main className="app-shell account-page tw-accounts tw-recovery">
    <Link className="back-link" href="/account">‹ Back to account</Link>
    <section className="account-hero"><span className="eyebrow">TrolleyWise account security</span><h1>Verify your email</h1><p>Verification links expire after 24 hours and only work once. Opening a link does not verify your email until you confirm below.</p></section>
    <section className="account-card account-auth-card">
      {!ready && <p role="status">Reading your verification link…</p>}
      {token && !done && <button className="button button-primary" disabled={busy} onClick={() => void confirm()}>{busy ? "Verifying…" : "Verify email address"}</button>}
      {ready && !token && !done && <><p>Request a fresh verification link for your email/password account.</p><p className="tw-helper">{config?.emailMessage || "Checking email readiness…"}</p><form className="account-auth-form" onSubmit={request} aria-busy={busy}><label><span>Email address</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={320} required disabled={busy || !config?.emailFlowsEnabled} /></label><button className="button button-primary" disabled={busy || !config?.emailFlowsEnabled}>{busy ? "Requesting…" : "Request verification link"}</button></form><p className="tw-helper">For privacy, we do not confirm whether an account exists. Google accounts use Google’s verification process.</p></>}
      {message && <p role="status">{message}</p>}
      {done && <Link className="button button-secondary" href="/account">Return to account</Link>}
      {token && !done && <Link className="tw-text-link" href="/account">Request a fresh link from your account</Link>}
    </section>
  </main>;
}
