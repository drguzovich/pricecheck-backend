import { readBrandedStorage } from "@/lib/brand-storage";

export type RecentSearch = {
  barcode: string;
  name: string;
  viewedAt: string;
};

const KEY = "trolleywise-recent-searches";
const LIMIT = 8;

export function readRecentSearches(): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(readBrandedStorage(KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RecentSearch => Boolean(item?.barcode && item?.name)).slice(0, LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function addRecentSearch(search: RecentSearch) {
  if (typeof window === "undefined") return;
  const next = [search, ...readRecentSearches().filter((item) => item.barcode !== search.barcode)].slice(0, LIMIT);
  window.localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("trolleywise-recent-searches"));
}
