import { NextResponse } from "next/server";
import { googleAuthEnabled } from "@/lib/auth-options";

export async function GET() {
  return NextResponse.json({ googleAuthEnabled });
}
