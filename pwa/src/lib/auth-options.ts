import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
// Application sessions and backend identity signatures are different trust domains.
const authSecret = process.env.NEXTAUTH_SECRET || process.env.APP_SESSION_SECRET;
export const accountSyncEnabled = Boolean(process.env.USER_SYNC_JWT_SECRET);
export const apiBaseUrl = process.env.PRICECHECK_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_PRICE_API_URL || "https://pricecheck-backend-7tkh.onrender.com";
const publicAuthUrl = process.env.NEXTAUTH_URL || process.env.AUTH_URL || "";
const localHttpAllowed = process.env.AUTH_TRUST_LOCAL_HTTP === "true" && /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(publicAuthUrl);
const useSecureCookies = !localHttpAllowed;
const cookieOptions = {
  httpOnly: true,
  sameSite: (useSecureCookies ? "none" : "lax") as "none" | "lax",
  path: "/",
  secure: useSecureCookies,
};
export const googleAuthEnabled = Boolean(googleClientId && googleClientSecret);
export const authSessionEnabled = Boolean(authSecret);

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(credentials, request) {
        const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || email.length > 320 || !password || password.length > 128) return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
          const proxyHeaders: Record<string, string> = {};
          if (process.env.USER_SYNC_JWT_SECRET) {
            for (const key of ["x-pricecheck-client", "x-pricecheck-timestamp", "x-pricecheck-signature"]) {
              const value = request.headers?.[key];
              if (typeof value === "string") proxyHeaders[key] = value;
            }
          }
          const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json", ...proxyHeaders },
            body: JSON.stringify({ email, password }),
            signal: controller.signal,
            cache: "no-store",
            redirect: "error",
          });
          if (!response.ok) return null;
          const body = await response.json() as { user?: { accountId?: string; email?: string; displayName?: string | null; authVersion?: number } };
          if (!body.user?.accountId || !body.user.email) return null;
          return { id: body.user.accountId, email: body.user.email, name: body.user.displayName ?? body.user.email, authVersion: body.user.authVersion ?? 0 };
        } catch {
          return null;
        } finally {
          clearTimeout(timeout);
        }
      },
    }),
    ...(googleAuthEnabled ? [GoogleProvider({ clientId: googleClientId as string, clientSecret: googleClientSecret as string })] : []),
  ],
  session: { strategy: "jwt" },
  secret: authSecret,
  useSecureCookies,
  cookies: {
    sessionToken: { name: useSecureCookies ? "__Secure-next-auth.session-token" : "next-auth.session-token", options: cookieOptions },
    callbackUrl: { name: useSecureCookies ? "__Secure-next-auth.callback-url" : "next-auth.callback-url", options: cookieOptions },
    csrfToken: { name: useSecureCookies ? "__Host-next-auth.csrf-token" : "next-auth.csrf-token", options: cookieOptions },
    pkceCodeVerifier: { name: useSecureCookies ? "__Secure-next-auth.pkce.code_verifier" : "next-auth.pkce.code_verifier", options: { ...cookieOptions, maxAge: 900 } },
    state: { name: useSecureCookies ? "__Secure-next-auth.state" : "next-auth.state", options: { ...cookieOptions, maxAge: 900 } },
    nonce: { name: useSecureCookies ? "__Secure-next-auth.nonce" : "next-auth.nonce", options: { ...cookieOptions, maxAge: 900 } },
  },
  callbacks: {
    async jwt({ token, account, profile, user }) {
      if (account?.provider === "google") token.accountId = (profile as { sub?: string } | undefined)?.sub || account.providerAccountId;
      if (account?.provider === "credentials" && user?.id) {
        token.accountId = user.id;
        token.authVersion = (user as { authVersion?: number }).authVersion ?? 0;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const principal = session.user as { id?: string; authVersion?: number };
        principal.id = typeof token.accountId === "string" ? token.accountId : undefined;
        principal.authVersion = typeof token.authVersion === "number" ? token.authVersion : undefined;
      }
      return session;
    },
    async redirect({ baseUrl }) {
      return `${baseUrl}/account`;
    },
  },
};
