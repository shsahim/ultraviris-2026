import path from "node:path";

export const IMAGE_EXT_FALLBACKS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

/** Strips leading `./` or `/` and whitespace from a stored File_Location. */
export function normalizeFileLocation(fileLocation: string): string {
  return (fileLocation ?? "").replace(/^\.?\/+/, "").trim();
}

/**
 * Returns the relative path that exists, trying sibling extensions when the
 * stored extension does not match the file on disk or in S3.
 */
export function resolveFileLocationWithFallback(
  relative: string,
  exists: (relative: string) => boolean
): string {
  if (!relative || exists(relative)) return relative;

  const ext = path.extname(relative);
  const base = relative.slice(0, relative.length - ext.length);
  for (const alt of IMAGE_EXT_FALLBACKS) {
    if (alt === ext.toLowerCase()) continue;
    const candidate = base + alt;
    if (exists(candidate)) return candidate;
  }

  return relative;
}

/** True when the file (or a same-basename sibling with another image ext) exists. */
export function imageExistsWithFallback(
  fileLocation: string,
  exists: (relative: string) => boolean
): boolean {
  const relative = normalizeFileLocation(fileLocation);
  if (!relative) return false;
  return resolveFileLocationWithFallback(relative, exists) !== relative
    ? true
    : exists(relative);
}
