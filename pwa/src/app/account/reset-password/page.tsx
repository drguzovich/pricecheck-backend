"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { performAuthFlow, takeLinkToken } from "@/lib/auth-flows";
import "@/styles/accounts.css";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const tokenRead = useRef(false);
  useEffect(() => {
    if (tokenRead.current) return;
    tokenRead.current = true;
    setToken(takeLinkToken());
    setReady(true);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || busy || done) return;
    if (password !== confirmation) { setMessage("The passwords do not match."); return; }
    setBusy(true);
    setMessage("");
    try {
      const result = await performAuthFlow("confirmPasswordReset", { token, password });
      setMessage(result.message || "Your password has been changed. Sign in with your new password.");
      setDone(true);
      setToken("");
      setPassword("");
      setConfirmation("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to change your password."); }
    finally { setBusy(false); }
  }
  return <main className="app-shell account-page tw-accounts tw-recovery">
    <Link className="back-link" href="/account">‹ Back to account</Link>
    <section className="account-hero"><span className="eyebrow">TrolleyWise account security</span><h1>Choose a new password</h1><p>Nothing changes until you submit this form. Reset links can only be used once.</p></section>
    <section className="account-card account-auth-card">
      {!ready && <p role="status">Reading your reset link…</p>}
      {ready && !token && !done && <p>This link is missing or invalid. Request a fresh reset link and open it from your email.</p>}
      {ready && token && !done && <form className="account-auth-form" onSubmit={submit} aria-busy={busy}><label><span>New password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required disabled={busy} /></label><label><span>Confirm new password</span><input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required disabled={busy} /></label><small>Use 10 to 128 characters. This changes only your email/password account.</small><button type="submit" className="button button-primary" disabled={busy}>{busy ? "Changing password…" : "Change password"}</button></form>}
      {message && <p role="status">{message}</p>}
      {done ? <Link className="button button-primary" href="/account">Sign in with new password</Link> : <Link className="tw-text-link" href="/account/forgot-password">Request a new reset link</Link>}
    </section>
  </main>;
}
