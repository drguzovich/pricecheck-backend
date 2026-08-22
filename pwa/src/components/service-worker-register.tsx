"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      // The Manus preview uses a live Next.js development server. Remove any
      // prior worker and shell cache so its changing webpack chunks cannot be
      // served from a previous phone test.
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => registration.unregister());
      });
      if ("caches" in window) {
        caches.keys().then((keys) => keys.filter((key) => key.startsWith("pricecheck-shell-")).forEach((key) => caches.delete(key)));
      }
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app remains usable online if registration is unavailable.
    });
  }, []);

  return null;
}
