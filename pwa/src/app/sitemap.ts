import type { MetadataRoute } from "next";
import { publicSiteOrigin } from "@/site-config";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicSiteOrigin();
  if (!origin) return [];
  return ["", "/search", "/scan", "/about", "/privacy", "/terms"].map((path) => ({ url: `${origin}${path}` }));
}
