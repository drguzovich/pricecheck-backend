import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";

const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;

export function visitorIdentity(request: NextRequest) {
  // Managed gateways append their trusted client hop. Never trust a caller's
  // leftmost arbitrary forwarding chain. Standalone HTTP falls back to req.ip.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const address = request.ip || (forwarded && isIP(forwarded) ? forwarded : "unknown");
  return createHash("sha256").update(address).digest("hex");
}

export function consumePriceBudget(identity: string) {
  const now = Date.now();
  if (buckets.size > 5000) {
    buckets.forEach((value, key) => { if (value.resetAt <= now) buckets.delete(key); });
    if (buckets.size > 5000) buckets.delete(buckets.keys().next().value as string);
  }
  let bucket = buckets.get(identity);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(identity, bucket);
  }
  bucket.count += 1;
  return { allowed: bucket.count <= 30, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

export function signedVisitorHeaders(identity: string): Record<string, string> {
  const secret = process.env.USER_SYNC_JWT_SECRET;
  if (!secret) return {};
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`${timestamp}:${identity}`).digest("hex");
  return { "X-PriceCheck-Client": identity, "X-PriceCheck-Timestamp": timestamp, "X-PriceCheck-Signature": signature };
}
