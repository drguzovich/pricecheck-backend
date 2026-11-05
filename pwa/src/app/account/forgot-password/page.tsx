"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { loadAuthReadiness, performAuthFlow, type AuthReadiness } from "@/lib/auth-flows";
import "@/styles/accounts.css";

export default function ForgotPasswordPage() {
  const [config, setConfig] = useState<AuthReadiness | null>(null);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [configFailed, setConfigFailed] = useState(false);
  async function checkReadiness() {
    setConfigFailed(false);
    try { setConfig(await loadAuthReadiness()); }
    catch { setConfigFailed(true); }
  }
  useEffect(() => { void checkReadiness(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !config?.emailFlowsEnabled) return;
    setBusy(true);
    setMessage("");
    try { setMessage((await performAuthFlow("requestPasswordReset", { email })).message || "Request received."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to request a link."); }
    finally { setBusy(false); }
  }
  return <main className="app-shell account-page tw-accounts tw-recovery">
    <Link className="back-link" href="/account">‹ Back to account</Link>
    <section className="account-hero"><span className="eyebrow">TrolleyWise account security</span><h1>Reset your password</h1><p>For email/password accounts, request a single-use link that expires after 30 minutes. Google accounts manage their passwords with Google.</p></section>
    <section className="account-card account-auth-card">
      <p className="tw-helper" role="status">{config?.emailMessage || (configFailed ? "Email recovery readiness could not be checked." : "Checking email recovery readiness…")}</p>
      {configFailed && <button className="button button-secondary" onClick={() => void checkReadiness()}>Retry readiness check</button>}
      <form className="account-auth-form" onSubmit={submit} aria-busy={busy}><label><span>Email address</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={320} required disabled={busy || !config?.emailFlowsEnabled} /></label><button type="submit" className="button button-primary" disabled={busy || !config?.emailFlowsEnabled}>{busy ? "Requesting…" : "Request reset link"}</button></form>
      {message && <p role="status">{message}</p>}
      <p className="tw-helper">For privacy, the response does not confirm whether an account exists. A request is not proof of email delivery.</p>
    </section>
  </main>;
}
