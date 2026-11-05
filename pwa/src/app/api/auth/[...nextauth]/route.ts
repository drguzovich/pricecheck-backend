import NextAuth from "next-auth";
import { NextRequest } from "next/server";
import { authOptions, authSessionEnabled } from "@/lib/auth-options";
import { authPostGuard, forwardAuthRequest } from "@/lib/remote-auth";
import { signedVisitorHeaders, visitorIdentity } from "@/proxy-identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handler = NextAuth(authOptions);
type AuthContext = { params: { nextauth: string[] } };
export async function GET(request: NextRequest, context: AuthContext) {
  if (!authSessionEnabled) return forwardAuthRequest(request);
  return handler(request, context);
}
export async function POST(request: NextRequest, context: AuthContext) {
  if (!authSessionEnabled) return forwardAuthRequest(request);
  const blocked = authPostGuard(request);
  if (blocked) return blocked;
  const identity = visitorIdentity(request);
  const headers = new Headers(request.headers);
  // Do not forward caller-invented proxy signatures into credential authorization.
  for (const key of ["x-pricecheck-client", "x-pricecheck-timestamp", "x-pricecheck-signature"]) headers.delete(key);
  if (process.env.USER_SYNC_JWT_SECRET) {
    for (const [key, value] of Object.entries(signedVisitorHeaders(identity))) headers.set(key, value);
  }
  return handler(new NextRequest(request, { headers }), context);
}
