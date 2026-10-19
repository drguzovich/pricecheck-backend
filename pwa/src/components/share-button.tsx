"use client";

import { useState } from "react";
import { ShareIcon } from "@/components/icons";

type ShareButtonProps = {
  productName: string;
  bestPrice: number | null;
  bestRetailer: string | null;
};

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy was not available");
}

export function ShareButton({ productName, bestPrice, bestRetailer }: ShareButtonProps) {
  const [message, setMessage] = useState("");
  const canShare = typeof bestPrice === "number" && Boolean(bestRetailer);

  const share = async () => {
    if (!canShare || bestPrice === null || !bestRetailer) return;
    const text = `${productName} — best price R${bestPrice.toFixed(2)} at ${bestRetailer}. PriceCheck: ${window.location.href}`;
    setMessage("");
    try {
      if (navigator.share) {
        await navigator.share({ title: productName, text });
      } else {
        await copyText(text);
        setMessage("Price comparison copied.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("Could not share this comparison. Please try again.");
    }
  };

  return (
    <span className="share-control">
      <button className="button button-secondary share-button" type="button" onClick={share} disabled={!canShare} aria-describedby={!canShare ? "share-unavailable-note" : undefined}>
        <ShareIcon size={18} /> <span>Share</span>
      </button>
      {!canShare && <small id="share-unavailable-note">No confirmed price to share yet.</small>}
      {message && <small role="status">{message}</small>}
    </span>
  );
}
