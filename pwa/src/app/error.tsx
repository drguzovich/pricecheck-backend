"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { Sentry.captureException(error); }, [error]);
  return <main className="app-shell error-panel"><span className="eyebrow">Something went wrong</span><h1>PriceCheck needs another try.</h1><p>We recorded the technical detail without including your shopping data. You can retry this page or return to a scan.</p><div><button className="button button-primary" onClick={reset}>Retry</button><a className="button button-secondary" href="/scan">Scan a product</a></div></main>;
}
