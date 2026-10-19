import NextAuth from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions, authSessionEnabled } from "@/lib/auth-options";

const handler = NextAuth(authOptions);

type AuthContext = { params: { nextauth: string[] } };

function unavailable() {
  return NextResponse.json(
    { error: "auth_unconfigured", message: "Account sign-in is unavailable until the application session secret is configured." },
    { status: 503 },
  );
}

export async function GET(request: NextRequest, context: AuthContext) {
  if (!authSessionEnabled) return unavailable();
  return handler(request, context);
}

export async function POST(request: NextRequest, context: AuthContext) {
  if (!authSessionEnabled) return unavailable();
  return handler(request, context);
}
