import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import jwt from "jsonwebtoken";
import { authOptions } from "@/lib/auth-options";

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  const accountId = (session?.user as { id?: string } | undefined)?.id;
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.USER_SYNC_JWT_SECRET;
  if (!email || !accountId || !secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = jwt.sign(
    { account_id: accountId, email, display_name: session?.user?.name ?? null },
    secret,
    { algorithm: "HS256", expiresIn: "15m" },
  );
  return NextResponse.json({ token, user: { email, displayName: session?.user?.name ?? null } });
}
