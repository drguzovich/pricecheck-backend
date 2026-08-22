import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

export const googleAuthEnabled = Boolean(googleClientId && googleClientSecret);

export const authOptions: NextAuthOptions = {
  providers: googleAuthEnabled
    ? [GoogleProvider({ clientId: googleClientId as string, clientSecret: googleClientSecret as string })]
    : [],
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.provider === "google") token.googleId = (profile as { sub?: string } | undefined)?.sub || account.providerAccountId;
      return token;
    },
    async session({ session, token }) {
      if (session.user) (session.user as { id?: string }).id = typeof token.googleId === "string" ? token.googleId : undefined;
      return session;
    },
  },
};
