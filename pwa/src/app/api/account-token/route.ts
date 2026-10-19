import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import jwt from "jsonwebtoken";
import { authOptions, authSessionEnabled } from "@/lib/auth-options";

export async function GET() {
  if (!authSessionEnabled) {
    return NextResponse.json({ error: "auth_unconfigured", message: "Account sign-in is unavailable until the application session secret is configured." }, { status: 503 });
  }
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  const accountId = (session?.user as { id?: string } | undefined)?.id;
  const secret = process.env.USER_SYNC_JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (!email || !accountId || !secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = jwt.sign(
    { account_id: accountId, google_id: accountId, email, display_name: session?.user?.name ?? null },
    secret,
    { algorithm: "HS256", expiresIn: "15m" },
  );
  return NextResponse.json({ token, user: { email, displayName: session?.user?.name ?? null } });
}
