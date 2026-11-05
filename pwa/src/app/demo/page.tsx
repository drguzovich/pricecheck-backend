"use client";

import { useEffect, useState } from "react";
import { addDemoScan, DEMO_PRODUCTS, freshDemoState, loadDemoState, resetDemoState, saveDemoState, toggleDemoFavourite, type DemoState } from "@/lib/demo-data";
import "@/styles/accounts.css";

export default function DemoPage() {
  const [state, setState] = useState<DemoState>(freshDemoState);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    try { setState(loadDemoState(window.localStorage)); }
    catch { setMessage("Device storage is unavailable. You can still try this demo in the current tab."); }
    setReady(true);
  }, []);
  function update(next: DemoState, confirmation: string) {
    setState(next);
    let saved = false;
    try { saved = saveDemoState(window.localStorage, next); } catch { /* Blocked storage stays on this screen. */ }
    setMessage(`${confirmation}${saved ? " Demo changes stay on this device." : " Device storage is unavailable, so changes last only in this tab."}`);
  }
  function reset() {
    let next = freshDemoState();
    try { next = resetDemoState(window.localStorage); } catch { /* Do not touch any guest/account state. */ }
    setState(next);
    setMessage("Demo fixtures reset. Real guest and account data have not been changed.");
  }
  return <main className="app-shell account-page tw-accounts tw-demo">
    <a className="back-link" href="/account">‹ Leave demo</a>
    <section className="account-hero"><span className="tw-demo-badge">Isolated on-device demo</span><h1>A small look at your watchlist</h1><p>These are fictional fixtures, not an authenticated account. Try saving several items without signing in.</p></section>
    <section className="tw-notice"><h2>Nothing here is live</h2><p>No real prices, retailer listings, ingredient information or health scores are shown. This demo does not scan barcodes, contact user APIs, create alerts or sync anything to the cloud. It never signs you in or out.</p><p className="tw-helper">Your actual guest history and favourites use separate storage. Only this demo’s own fixture key is read or changed.</p></section>
    <section className="tw-totals" aria-label="Demo totals"><div className="account-stats"><div><strong>{ready ? state.favourites.length : "…"}</strong><span>Demo items saved</span></div><div><strong>{ready ? state.scanned.length : "…"}</strong><span>Demo items explored</span></div><div><strong>On-device</strong><span>No cloud account</span></div></div></section>
    <section className="tw-demo-products" aria-label="Fictional demo items">
      {DEMO_PRODUCTS.map((product) => <article className="tw-demo-product" key={product.id}><div><span className="eyebrow">Fictional fixture</span><h2>{product.name}</h2><p>{product.detail}</p><p>Price unavailable in demo. No ingredient or nutrition data.</p>{state.scanned.includes(product.id) && <p>Explored in this demo</p>}</div><button className="button button-secondary" disabled={!ready} aria-pressed={state.favourites.includes(product.id)} aria-label={`${state.favourites.includes(product.id) ? "Remove" : "Save"} ${product.name} in demo`} onClick={() => update(toggleDemoFavourite(state, product.id), `${state.favourites.includes(product.id) ? "Removed" : "Saved"} ${product.name}.`)}>{state.favourites.includes(product.id) ? "Saved in demo" : "Save in demo"}</button><button className="button button-secondary" disabled={!ready} onClick={() => update(addDemoScan(state, product.id), `Explored ${product.name}.`)}>Explore fixture</button></article>)}
    </section>
    <p className="tw-demo-status" role="status" aria-live="polite">{message}</p>
    <div className="tw-demo-controls"><button className="button button-secondary" disabled={!ready} onClick={reset}>Reset demo fixtures</button><a className="button button-primary" href="/account">Use a real account</a><a className="tw-text-link" href="/">Shop as a guest</a></div>
  </main>;
}
