import Link from "next/link";

export default function OfflinePage() {
  return <main className="app-shell offline-page"><span className="eyebrow">Connection unavailable</span><h1>You’re offline — showing cached prices</h1><p>TrolleyWise cannot refresh retailer prices without a connection. Previously visited result pages and on-device history remain available until you reconnect.</p><Link className="button button-primary" href="/history">View saved scans</Link></main>;
}
