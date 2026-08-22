"use client";

import { useState } from "react";

export function ShareButton({ title }: { title: string }) {
  const [message, setMessage] = useState("");
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title, text: `Compare prices for ${title} on PriceCheck.`, url });
      else { await navigator.clipboard.writeText(url); setMessage("Link copied."); }
    } catch { setMessage("Sharing was cancelled."); }
  };
  return <span className="share-control"><button className="button button-secondary" type="button" onClick={share}>Share</button>{message && <small role="status">{message}</small>}</span>;
}
