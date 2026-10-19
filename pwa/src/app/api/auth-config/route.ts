import { NextResponse } from "next/server";
import { authSessionEnabled, googleAuthEnabled } from "@/lib/auth-options";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    authSessionEnabled,
    googleAuthEnabled,
    googleMessage: googleAuthEnabled
      ? null
      : "Google sign-in is unavailable until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are configured.",
    sessionMessage: authSessionEnabled
      ? null
      : "Account sign-in is unavailable until the application session secret is configured.",
  });
}
