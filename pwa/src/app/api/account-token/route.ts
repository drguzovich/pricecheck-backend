import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import jwt from "jsonwebtoken";
import { authOptions, authSessionEnabled } from "@/lib/auth-options";
import { forwardAuthRequest } from "@/lib/remote-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  if (!authSessionEnabled) return forwardAuthRequest(request);
  const secret = process.env.USER_SYNC_JWT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "account_sync_unconfigured", message: "Account sync is unavailable until its independent signing key is configured." }, { status: 503, headers });
  }
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  const principal = session?.user as { id?: string; authVersion?: number } | undefined;
  const accountId = principal?.id;
  if (!email || !accountId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const token = jwt.sign(
    { account_id: accountId, google_id: accountId, email, display_name: session?.user?.name ?? null, auth_version: principal?.authVersion ?? 0 },
    secret,
    { algorithm: "HS256", expiresIn: "15m" },
  );
  return NextResponse.json({ token, user: { email, displayName: session?.user?.name ?? null } }, { headers });
}
