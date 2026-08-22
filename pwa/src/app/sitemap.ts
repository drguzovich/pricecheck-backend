import type { MetadataRoute } from "next";

const baseUrl = process.env.NEXTAUTH_URL || "https://pricecheck.app";
export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/search", "/scan", "/about", "/privacy", "/terms"].map((path) => ({ url: `${baseUrl}${path}`, lastModified: new Date() }));
}
