export const backendConfiguredBaseUrl =
  process.env.NEXT_PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_PRICE_API_URL ?? "";

/**
 * Browser requests intentionally use this application's origin. The route handler
 * validates the path and forwards it to the configured price service, avoiding
 * cross-origin cookies and CORS dependencies.
 */
export const BACKEND_PROXY_PREFIX = "/api/backend";

export function backendUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${BACKEND_PROXY_PREFIX}${normalizedPath}`;
}

export async function backendRequest(path: string, init?: RequestInit) {
  return fetch(backendUrl(path), {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
}
