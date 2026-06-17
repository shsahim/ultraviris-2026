// Central site metadata shared by layout, sitemap, robots, and structured data.
// Override the canonical origin per environment with NEXT_PUBLIC_SITE_URL.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://nataliernathan.com"
).replace(/\/+$/, "");

export const SITE_NAME = "Natalie R Nathan";

export const SITE_DESCRIPTION =
  "Natalie-Rose Nathan is a fine artist, video editor and producer, dancer, " +
  "and musician based in Los Angeles. Explore her paintings, projects, and exhibitions.";
