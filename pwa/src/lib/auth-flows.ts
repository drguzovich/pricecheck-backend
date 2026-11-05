export type AuthFlowAction = "requestVerification" | "confirmVerification" | "requestPasswordReset" | "confirmPasswordReset";

export type AuthReadiness = {
  authSessionEnabled: boolean;
  accountSyncEnabled: boolean;
  googleAuthEnabled: boolean;
  googleDeliveryVerified?: false;
  googleMessage: string | null;
  sessionMessage: string | null;
  emailFlowsEnabled: boolean;
  emailProviderConfigured: boolean;
  emailDeliveryVerified: boolean;
  emailMessage: string;
};

export async function loadAuthReadiness(): Promise<AuthReadiness> {
  const response = await fetch("/api/auth-config", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("Account configuration is temporarily unavailable.");
  return response.json() as Promise<AuthReadiness>;
}

export async function performAuthFlow(action: AuthFlowAction, input: { email?: string; token?: string; password?: string }) {
  const response = await fetch("/api/auth-config", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ action, ...input }),
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as { message?: string; ok?: boolean };
  if (!response.ok) throw new Error(body.message || "This request could not be completed. Please try again.");
  return body;
}

export async function loadVerificationStatus() {
  const response = await fetch("/api/auth-config?verification=1", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("Email verification status is temporarily unavailable.");
  return response.json() as Promise<{ provider: string; emailVerified: boolean }>;
}

/** Remove bearer links from the address bar immediately. Confirmation stays explicit. */
export function takeLinkToken(): string {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token") || "";
  window.history.replaceState(window.history.state, "", window.location.pathname);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
}

const authBuckets = new Map<string, { count: number; resetAt: number }>();
/** In-process edge hook. Backend has independent per-IP and per-email limiters. */
export function consumeAuthBudget(identity: string, now = Date.now()) {
  const windowMs = 15 * 60 * 1000;
  if (authBuckets.size >= 5000) {
    authBuckets.forEach((value, key) => { if (value.resetAt <= now) authBuckets.delete(key); });
    if (authBuckets.size >= 5000 && !authBuckets.has(identity)) return { allowed: false, retryAfter: 60 };
  }
  let bucket = authBuckets.get(identity);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    authBuckets.set(identity, bucket);
  }
  bucket.count += 1;
  return { allowed: bucket.count <= 40, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}
