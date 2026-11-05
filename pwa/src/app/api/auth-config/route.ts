import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import jwt from "jsonwebtoken";
import { authOptions, authSessionEnabled, googleAuthEnabled, accountSyncEnabled, apiBaseUrl } from "@/lib/auth-options";
import { type AuthFlowAction } from "@/lib/auth-flows";
import { authPostGuard, forwardAuthRequest } from "@/lib/remote-auth";
import { signedVisitorHeaders, visitorIdentity } from "@/proxy-identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const privateHeaders = { "Cache-Control": "private, no-store" };
const actions: Record<AuthFlowAction, string> = {
  requestVerification: "/auth/verification/request",
  confirmVerification: "/auth/verification/confirm",
  requestPasswordReset: "/auth/password-reset/request",
  confirmPasswordReset: "/auth/password-reset/confirm",
};
async function backend(path: string, init: RequestInit = {}) {
  const target = new URL(`${apiBaseUrl.replace(/\/$/, "")}${path}`);
  if (!["https:", "http:"].includes(target.protocol)) throw new Error("Invalid backend protocol");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(target, { ...init, cache: "no-store", redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: NextRequest) {
  if (!authSessionEnabled) return forwardAuthRequest(request);
  if (request.nextUrl.searchParams.get("verification") === "1") {
    if (!authSessionEnabled || !accountSyncEnabled) return NextResponse.json({ error: "auth_unavailable" }, { status: 503, headers: privateHeaders });
    const session = await getServerSession(authOptions);
    const principal = session?.user as { id?: string; authVersion?: number } | undefined;
    if (!principal?.id || !session?.user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: privateHeaders });
    const token = jwt.sign({ account_id: principal.id, email: session.user.email, auth_version: principal.authVersion ?? 0 }, process.env.USER_SYNC_JWT_SECRET as string, { algorithm: "HS256", expiresIn: "1m" });
    try {
      const response = await backend("/auth/verification/status", { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
      const body = await response.json();
      return NextResponse.json(body, { status: response.status, headers: privateHeaders });
    } catch {
      return NextResponse.json({ error: "auth_flows_unavailable", message: "Email verification status is temporarily unavailable." }, { status: 503, headers: privateHeaders });
    }
  }
  let mail = { emailFlowsEnabled: false, emailProviderConfigured: false, emailDeliveryVerified: false, emailMessage: "Email verification and password reset are temporarily unavailable." };
  try {
    const response = await backend("/auth/readiness", { headers: { Accept: "application/json" } });
    if (response.ok) {
      const body = await response.json() as typeof mail;
      mail = { emailFlowsEnabled: body.emailFlowsEnabled === true, emailProviderConfigured: body.emailProviderConfigured === true, emailDeliveryVerified: false, emailMessage: typeof body.emailMessage === "string" ? body.emailMessage : mail.emailMessage };
    }
  } catch { /* Optional email configuration never disables guest use or login. */ }
  return NextResponse.json({
    authSessionEnabled,
    accountSyncEnabled,
    googleAuthEnabled,
    googleDeliveryVerified: false,
    googleMessage: googleAuthEnabled
      ? "Google credentials are configured. Successful sign-in still depends on the provider and the registered callback URL."
      : "Google sign-in is unavailable until Google credentials are configured.",
    sessionMessage: !authSessionEnabled
      ? "Account sign-in is unavailable until the application session secret is configured."
      : !accountSyncEnabled ? "Sign-in is configured, but cloud account sync needs its independent signing key." : null,
    ...mail,
  }, { headers: privateHeaders });
}

export async function POST(request: NextRequest) {
  if (!authSessionEnabled) return forwardAuthRequest(request);
  const blocked = authPostGuard(request);
  if (blocked) return blocked;
  if (!request.headers.get("content-type")?.includes("application/json")) return NextResponse.json({ error: "invalid_request" }, { status: 415, headers: privateHeaders });
  if (Number(request.headers.get("content-length") || 0) > 4096) return NextResponse.json({ error: "request_too_large" }, { status: 413, headers: privateHeaders });
  let input: { action?: string; email?: string; token?: string; password?: string };
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 4096) return NextResponse.json({ error: "request_too_large" }, { status: 413, headers: privateHeaders });
    input = JSON.parse(text);
    if (!input || typeof input !== "object" || typeof input.action !== "string" || !Object.hasOwn(actions, input.action)) throw new Error("Invalid action");
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Choose a valid account action." }, { status: 400, headers: privateHeaders });
  }
  const path = actions[input.action as AuthFlowAction];
  const payload = path.endsWith("/request")
    ? { email: typeof input.email === "string" && input.email.length <= 320 ? input.email : "" }
    : { token: typeof input.token === "string" ? input.token.slice(0, 100) : "", password: typeof input.password === "string" ? input.password.slice(0, 129) : undefined };
  try {
    const identityHeaders = process.env.USER_SYNC_JWT_SECRET ? signedVisitorHeaders(visitorIdentity(request)) : {};
    const response = await backend(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...identityHeaders }, body: JSON.stringify(payload) });
    const body = await response.json();
    const outgoing = new Headers(privateHeaders);
    const retry = response.headers.get("retry-after");
    if (retry) outgoing.set("Retry-After", retry);
    return NextResponse.json(body, { status: response.status, headers: outgoing });
  } catch {
    return NextResponse.json({ error: "auth_flows_unavailable", message: "Account recovery is temporarily unavailable. Please try again later." }, { status: 503, headers: privateHeaders });
  }
}
