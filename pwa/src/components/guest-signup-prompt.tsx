"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { readGuestHistory } from "@/lib/guest-data";

export function GuestSignupPrompt() {
  const { status } = useSession();
  if (status !== "unauthenticated" || readGuestHistory().length < 3) return null;
  return <aside className="guest-signup-prompt"><strong>Keep your scans across devices</strong><p>You have built a useful history. Create a free account to save scans, favourites, and alerts.</p><Link className="button button-primary" href="/account">Create free account</Link></aside>;
}
