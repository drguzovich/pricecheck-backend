import Link from "next/link";

export default function OfflinePage() {
  return <main className="app-shell offline-page"><span className="eyebrow">Connection unavailable</span><h1>You are offline</h1><p>PriceCheck cannot refresh retailer prices without a connection. You can still revisit previously loaded pages and use on-device history.</p><Link className="button button-primary" href="/history">View saved scans</Link></main>;
}
