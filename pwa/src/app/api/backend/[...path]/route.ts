import { NextRequest, NextResponse } from "next/server";
import { consumePriceBudget, signedVisitorHeaders, visitorIdentity } from "@/proxy-identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_PATHS = [
  /^price\/\d{8,14}(?:\/refresh)?$/,
  /^product\/\d{8,14}\/health$/,
  /^api\/search$/,
  /^coverage$/,
  /^product-requests$/,
  /^users\/(?:me|migrate|scans|favourites|alerts)$/,
  /^auth\/(?:login|register)$/,
];

async function proxy(request: NextRequest, context: { params: { path: string[] } }) {
  const path = context.params.path.join("/");
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const identity = visitorIdentity(request);
  if (path.startsWith("price/")) {
    const budget = consumePriceBudget(identity);
    if (!budget.allowed) return NextResponse.json({ error: "rate_limited", message: "Too many price requests. Please wait before trying again." }, { status: 429, headers: { "Retry-After": String(budget.retryAfter), "Cache-Control": "no-store" } });
  }
  const base = process.env.PRICECHECK_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_PRICE_API_URL || "https://pricecheck-backend-7tkh.onrender.com";
  let target: URL;
  try {
    target = new URL(`${base.replace(/\/$/, "")}/${path}`);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("Invalid protocol");
    target.search = request.nextUrl.search;
  } catch {
    return NextResponse.json({ error: "service_unconfigured", message: "The price service is not configured." }, { status: 503 });
  }
  const headers = new Headers({ Accept: "application/json", ...signedVisitorHeaders(identity) });
  const authorization = request.headers.get("authorization");
  if (authorization && path.startsWith("users/")) headers.set("Authorization", authorization);
  let body: string | undefined;
  if (request.method === "POST") {
    if (Number(request.headers.get("content-length") || 0) > 262144) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    body = await request.text();
    if (Buffer.byteLength(body) > 262144) return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    if (body) headers.set("Content-Type", "application/json");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch(target, { method: request.method, headers, body, signal: controller.signal, cache: "no-store", redirect: "error" });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json({ error: "service_waking", message: "The price service is waking up. Please try again shortly." }, { status: 503 });
    }
    const payload = await response.text();
    const outgoing = new Headers({ "Content-Type": "application/json", "Cache-Control": "private, no-store" });
    for (const key of ["retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"]) {
      const value = response.headers.get(key);
      if (value) outgoing.set(key, value);
    }
    return new NextResponse(payload, { status: response.status, headers: outgoing });
  } catch {
    return NextResponse.json({ error: "service_unavailable", message: "The price service is temporarily unavailable. Your saved comparisons are still on this device." }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
