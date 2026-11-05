// Existing device records are copied, not deleted. A canonical empty value is
// deliberately retained so clearing or cloud migration cannot resurrect old data.
export function readBrandedStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(key);
  if (value !== null) return value;
  const legacyKey = key.replace(/^trolleywise/, "pricecheck");
  if (legacyKey === key) return null;
  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy === null) return null;
  window.localStorage.setItem(key, legacy);
  return legacy;
}

export function announceGuestChange() {
  window.dispatchEvent(new Event("trolleywise-guest-data"));
  // Existing mounted screens from an old PWA update remain responsive.
  window.dispatchEvent(new Event("pricecheck-guest-data"));
}
