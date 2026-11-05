import { NextRequest, NextResponse } from "next/server";
import { consumeAuthBudget } from "@/lib/auth-flows";
import { visitorIdentity } from "@/proxy-identity";

const DEFAULT_AUTH_SERVER = "https://pricecheck-backend-7tkh.onrender.com";
const PUBLIC_AUTH_ORIGIN = "https://pricecheck-7dykljea.manus.space";
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Pragma: "no-cache" };
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const AUTH_ACTIONS = new Set(["session", "csrf", "providers", "signin", "signout", "callback", "error", "verify-request"]);
const POST_ACTIONS = new Set(["session", "signin", "signout", "callback"]);
const GOOGLE_CALLBACK_QUERY = new Set(["code", "state", "scope", "authuser", "prompt", "error", "error_description", "error_uri", "session_state", "iss"]);
const GOOGLE_SIGNIN_QUERY = new Set(["scope", "prompt", "login_hint", "hd", "access_type", "include_granted_scopes", "display"]);
// These are application cookies only, not any Manus/platform cookies on the caller.
const AUTH_COOKIE = /^(?:(?:__Secure-|__Host-))?next-auth\.(?:session-token(?:\.\d+)?|callback-url|csrf-token|pkce\.code_verifier|state|nonce)$/;

type AuthPath = { kind: "nextauth" | "config" | "token"; action?: string; provider?: string };

function failure(status: number, error: string, message?: string) {
  return NextResponse.json({ error, ...(message ? { message } : {}) }, { status, headers: PRIVATE_HEADERS });
}

function unavailable() {
  return failure(503, "auth_backend_unavailable", "TrolleyWise account sign-in is temporarily unavailable. The account server may be waking up; please wait a moment and try again.");
}

function publicOrigins(request: NextRequest) {
  const origins = new Set([request.nextUrl.origin, PUBLIC_AUTH_ORIGIN]);
  try {
    if (process.env.NEXTAUTH_URL) {
      const url = new URL(process.env.NEXTAUTH_URL);
      if (!url.username && !url.password && (url.protocol === "https:" || localHttpAllowed(url))) origins.add(url.origin);
    }
  } catch { /* Invalid configuration must never expand the origin allowlist. */ }
  return origins;
}

function localHttpAllowed(url: URL) {
  return process.env.AUTH_TRUST_LOCAL_HTTP === "true" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Apply the existing per-visitor budget and a strict same-public-origin POST guard. */
export function authPostGuard(request: NextRequest): Response | null {
  const origin = request.headers.get("origin");
  if (!origin || !publicOrigins(request).has(origin)) {
    return failure(403, "origin_not_allowed", "Use the account form on this website.");
  }
  const budget = consumeAuthBudget(visitorIdentity(request));
  if (!budget.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many account requests. Please wait before trying again." },
      { status: 429, headers: { ...PRIVATE_HEADERS, "Retry-After": String(budget.retryAfter) } },
    );
  }
  return null;
}

function authPath(request: NextRequest): AuthPath | null {
  const path = request.nextUrl.pathname;
  if (path === "/api/account-token") return request.method === "GET" ? { kind: "token" } : null;
  if (path === "/api/auth-config") return { kind: "config" };
  const match = /^\/api\/auth\/([a-z-]+)(?:\/(google|credentials))?$/.exec(path);
  if (!match || !AUTH_ACTIONS.has(match[1])) return null;
  const [, action, provider] = match;
  if (provider && action !== "signin" && action !== "callback") return null;
  if (request.method === "POST" && !POST_ACTIONS.has(action)) return null;
  return { kind: "nextauth", action, provider };
}

function validQuery(request: NextRequest, path: AuthPath) {
  if (request.nextUrl.search.length > 8192) return false;
  const seen = new Set<string>();
  for (const [key, value] of Array.from(request.nextUrl.searchParams)) {
    if (seen.has(key) || seen.size >= 24 || value.length > 4096 || /[\x00\r\n]/.test(value)) return false;
    seen.add(key);
    if (path.kind === "token") return false;
    if (path.kind === "config") {
      if (request.method !== "GET" || key !== "verification" || value !== "1") return false;
      continue;
    }
    if (key === "callbackUrl") {
      try {
        const url = new URL(value, request.nextUrl.origin);
        if (url.username || url.password || !publicOrigins(request).has(url.origin)) return false;
      } catch { return false; }
      continue;
    }
    if (key === "error") continue;
    if (path.provider === "google" && path.action === "callback" && GOOGLE_CALLBACK_QUERY.has(key)) continue;
    if (path.provider === "google" && path.action === "signin" && GOOGLE_SIGNIN_QUERY.has(key)) continue;
    return false;
  }
  return true;
}

function authServer(request: NextRequest) {
  const configured = process.env.TROLLEYWISE_AUTH_SERVER_URL || process.env.PRICECHECK_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || DEFAULT_AUTH_SERVER;
  const target = new URL(configured);
  if (target.username || target.password || target.search || target.hash || target.pathname !== "/") throw new Error("Invalid auth server");
  if (target.protocol !== "https:" && !localHttpAllowed(target)) throw new Error("Insecure auth server");
  // Even an unconfigured backend must never proxy its own route back to itself.
  const requestHosts = [request.nextUrl.host, request.headers.get("host")];
  if (requestHosts.some(host => host?.toLowerCase() === target.host.toLowerCase())) throw new Error("Recursive auth server");
  target.pathname = request.nextUrl.pathname;
  target.search = request.nextUrl.search;
  return target;
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function safeLocation(value: string, request: NextRequest, path: AuthPath) {
  if (value.length > 8192 || /[\x00\r\n]/.test(value)) throw new Error("Invalid redirect");
  const url = new URL(value, request.nextUrl.origin);
  if (url.username || url.password) throw new Error("Invalid redirect");
  if (publicOrigins(request).has(url.origin)) return url.href;
  if (path.action === "signin" && path.provider === "google" && url.protocol === "https:" && url.host === "accounts.google.com" && ["/o/oauth2/v2/auth", "/o/oauth2/auth"].includes(url.pathname)) {
    const callback = new URL(url.searchParams.get("redirect_uri") || "");
    if (!callback.username && !callback.password && publicOrigins(request).has(callback.origin) && callback.pathname === "/api/auth/callback/google") return url.href;
  }
  throw new Error("Unsafe auth redirect");
}

function outgoingCookies(response: Response, target: URL) {
  // Never comma-split Set-Cookie: Expires contains commas and sessions can be chunked.
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (!headers.getSetCookie) {
    if (headers.has("set-cookie")) throw new Error("Separate cookie headers unavailable");
    return [];
  }
  return headers.getSetCookie().map(cookie => {
    const parts = cookie.split(";");
    const name = parts[0].slice(0, parts[0].indexOf("=")).trim();
    if (!AUTH_COOKIE.test(name)) throw new Error("Unexpected auth cookie");
    const hostOnly = [parts[0]];
    for (const attribute of parts.slice(1)) {
      const match = /^\s*domain\s*=\s*(.*?)\s*$/i.exec(attribute);
      if (!match) { hostOnly.push(attribute); continue; }
      if (match[1].replace(/^\./, "").toLowerCase() !== target.hostname.toLowerCase()) throw new Error("Foreign cookie domain");
      // Only the configured backend's Domain is removed; no foreign Domain is rewritten.
    }
    return hostOnly.join(";");
  });
}

/** Forward only the application auth routes. No platform JWT, signing key, or caller bearer header is used. */
export async function forwardAuthRequest(request: NextRequest): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return failure(405, "method_not_allowed");
  const path = authPath(request);
  if (!path) return failure(404, "auth_path_not_allowed");
  if (!validQuery(request, path)) return failure(400, "auth_query_not_allowed");
  let target: URL;
  try { target = authServer(request); } catch { return unavailable(); }

  const headers = new Headers();
  const accept = request.headers.get("accept");
  if (accept && accept.length <= 1024) headers.set("Accept", accept);
  const cookie = request.headers.get("cookie");
  if (cookie) {
    if (cookie.length > MAX_REQUEST_BYTES) return failure(431, "auth_headers_too_large");
    const cookies = cookie.split(";").map(part => part.trim()).filter(part => AUTH_COOKIE.test(part.slice(0, part.indexOf("="))));
    if (cookies.length) headers.set("Cookie", cookies.join("; "));
  }

  let body: Awaited<ReturnType<typeof readBounded>> | undefined;
  if (request.method === "POST") {
    const blocked = authPostGuard(request);
    if (blocked) return blocked;
    const contentType = request.headers.get("content-type") || "";
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (contentType.length > 256 || !["application/json", "application/x-www-form-urlencoded"].includes(mediaType) || (path.kind === "config" && mediaType !== "application/json")) return failure(415, "invalid_request");
    const length = request.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) return failure(413, "request_too_large");
    try { body = await readBounded(request.body, MAX_REQUEST_BYTES); } catch { return failure(413, "request_too_large"); }
    headers.set("Content-Type", contentType);
    headers.set("Origin", request.headers.get("origin") as string);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(target, { method: request.method, headers, ...(body ? { body } : {}), cache: "no-store", redirect: "manual", signal: controller.signal });
    if (response.status >= 500) {
      await response.body?.cancel();
      return unavailable();
    }
    const outgoing = new Headers(PRIVATE_HEADERS);
    for (const key of ["content-type", "retry-after"]) {
      const value = response.headers.get(key);
      if (value) outgoing.set(key, value);
    }
    const location = response.headers.get("location");
    if (location) outgoing.set("Location", safeLocation(location, request, path));
    for (const value of outgoingCookies(response, target)) outgoing.append("Set-Cookie", value);
    let payload = await readBounded(response.body, MAX_RESPONSE_BYTES);
    // NextAuth's json=true clients follow a JSON URL instead of a Location header.
    if (path.kind === "nextauth" && outgoing.get("content-type")?.toLowerCase().includes("application/json")) {
      const json = JSON.parse(new TextDecoder().decode(payload)) as { url?: unknown } | null;
      if (json && typeof json.url === "string") {
        json.url = safeLocation(json.url, request, path);
        payload = new TextEncoder().encode(JSON.stringify(json));
      }
    }
    return new Response([204, 205, 304].includes(response.status) ? null : payload, { status: response.status, headers: outgoing });
  } catch {
    // Do not log credential bodies, cookies, OAuth codes, or upstream secret-bearing errors.
    controller.abort();
    return unavailable();
  } finally {
    clearTimeout(timeout);
  }
}
