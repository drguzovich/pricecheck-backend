"use client";

import { useEffect, useRef, useState } from "react";

type DeferredInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallButton() {
  const [deferredPrompt, setDeferredPrompt] = useState<DeferredInstallPrompt | null>(null);
  const [showIOSHelp, setShowIOSHelp] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const visitsRef = useRef(0);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const visits = Number(window.localStorage.getItem("pricecheck-visits") || "0") + 1;
    visitsRef.current = visits;
    window.localStorage.setItem("pricecheck-visits", String(visits));
    if (ios && !standalone && visits >= 2) setShowIOSHelp(true);
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      if (visitsRef.current >= 2) setDeferredPrompt(event as DeferredInstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  if (!deferredPrompt && !showIOSHelp) return null;

  const install = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      return;
    }
    setExpanded((value) => !value);
  };

  return <span className="install-wrap"><button className="install-button" type="button" onClick={install}>Install app</button>{expanded && <span className="install-help" role="status">In Safari, tap <strong>Share</strong>, then choose <strong>Add to Home Screen</strong>.</span>}</span>;
}
