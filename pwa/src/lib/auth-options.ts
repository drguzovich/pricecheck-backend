import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const authSecret = process.env.NEXTAUTH_SECRET || process.env.USER_SYNC_JWT_SECRET;
const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_PRICE_API_URL || "https://pricecheck-backend-7tkh.onrender.com";
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
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || !password) return null;
        try {
          const response = await fetch(`${apiBaseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ email, password }),
            cache: "no-store",
          });
          if (!response.ok) return null;
          const body = await response.json() as { user?: { accountId?: string; email?: string; displayName?: string | null } };
          if (!body.user?.accountId || !body.user.email) return null;
          return { id: body.user.accountId, email: body.user.email, name: body.user.displayName ?? body.user.email };
        } catch {
          return null;
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
      if (account?.provider === "credentials" && user?.id) token.accountId = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) (session.user as { id?: string }).id = typeof token.accountId === "string" ? token.accountId : undefined;
      return session;
    },
  },
};
