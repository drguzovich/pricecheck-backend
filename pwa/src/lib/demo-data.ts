export const DEMO_STORAGE_KEY = "trolleywise-demo-fixtures-v1";

export const DEMO_PRODUCTS = Object.freeze([
  { id: "fixture-pantry", name: "Pantry staple", detail: "A fictional item for trying the save control." },
  { id: "fixture-breakfast", name: "Breakfast item", detail: "A fictional item for exploring an on-device watchlist." },
  { id: "fixture-cupboard", name: "Cupboard essential", detail: "A fictional item for trying a multi-item collection." },
]);
export type DemoState = { version: 1; favourites: string[]; scanned: string[] };
export type DemoStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const ids = new Set(DEMO_PRODUCTS.map((item) => item.id));
function cleanIds(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.filter((id): id is string => typeof id === "string" && ids.has(id)))).slice(0, DEMO_PRODUCTS.length) : [];
}
export function freshDemoState(): DemoState {
  return { version: 1, favourites: ["fixture-pantry", "fixture-breakfast"], scanned: [] };
}
export function loadDemoState(storage: DemoStorage): DemoState {
  try {
    const raw = storage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return freshDemoState();
    const parsed = JSON.parse(raw) as Partial<DemoState> | null;
    if (!parsed || parsed.version !== 1) return freshDemoState();
    return { version: 1, favourites: cleanIds(parsed.favourites), scanned: cleanIds(parsed.scanned) };
  } catch { return freshDemoState(); }
}
export function saveDemoState(storage: DemoStorage, state: DemoState) {
  try {
    storage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ version: 1, favourites: cleanIds(state.favourites), scanned: cleanIds(state.scanned) }));
    return true;
  } catch { return false; }
}
export function resetDemoState(storage: DemoStorage): DemoState {
  try { storage.removeItem(DEMO_STORAGE_KEY); } catch { /* Current-tab reset still works. */ }
  return freshDemoState();
}
export function toggleDemoFavourite(state: DemoState, id: string): DemoState {
  if (!ids.has(id)) return state;
  return { ...state, favourites: state.favourites.includes(id) ? state.favourites.filter((saved) => saved !== id) : cleanIds([...state.favourites, id]) };
}
export function addDemoScan(state: DemoState, id: string): DemoState {
  if (!ids.has(id)) return state;
  return { ...state, scanned: cleanIds([...state.scanned, id]) };
}
