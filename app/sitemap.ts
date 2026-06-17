import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Top-level, indexable routes. Project galleries live under /paintings via a
// ?project= query string and canonicalize to /paintings, so they're omitted
// here on purpose to avoid near-duplicate entries.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes: { path: string; priority: number; freq: "weekly" | "monthly" }[] =
    [
      { path: "/", priority: 1, freq: "weekly" },
      { path: "/paintings", priority: 0.8, freq: "weekly" },
      { path: "/resume", priority: 0.6, freq: "monthly" },
      { path: "/contact", priority: 0.5, freq: "monthly" },
    ];

  return routes.map(({ path, priority, freq }) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency: freq,
    priority,
  }));
}
