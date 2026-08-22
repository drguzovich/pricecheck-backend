export type RecentSearch = {
  barcode: string;
  name: string;
  viewedAt: string;
};

const KEY = "pricecheck-recent-searches";
const LIMIT = 8;

export function readRecentSearches(): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
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
}
