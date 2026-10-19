export function publicSiteOrigin(): string | undefined {
  const value = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXTAUTH_URL || process.env.PRICECHECK_WEB_URL;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.origin;
  } catch { return undefined; }
}
