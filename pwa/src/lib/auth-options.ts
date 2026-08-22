import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const authSecret = process.env.NEXTAUTH_SECRET ?? process.env.USER_SYNC_JWT_SECRET;
const apiBaseUrl = process.env.NEXT_PUBLIC_PRICE_API_URL ?? "https://pricecheck-backend-7tkh.onrender.com";

export const googleAuthEnabled = Boolean(googleClientId && googleClientSecret);

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
