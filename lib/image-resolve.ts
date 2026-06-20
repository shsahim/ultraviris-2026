import path from "node:path";

export const IMAGE_EXT_FALLBACKS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

/** Strips leading `./` or `/` and whitespace from a stored File_Location. */
export function normalizeFileLocation(fileLocation: string): string {
  return (fileLocation ?? "").replace(/^\.?\/+/, "").trim();
}

/**
 * Builds a browser-usable URL from a base URL and a relative object key,
 * URL-encoding each path segment (but not the `/` separators) so keys with
 * spaces or reserved characters (e.g. `#`, `?`) produce valid URLs. The key is
 * never mutated for storage — only the returned URL is encoded. Pass an empty
 * `baseUrl` to build a root-relative path (e.g. `/sub/a%20b.jpg`).
 */
export function toImageUrl(baseUrl: string, key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}/${encoded}`;
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

/** Filename without its extension (e.g. "foo.jpg" → "foo", "foo" → "foo"). */
function basenameStem(filename: string): string {
  const ext = path.extname(filename);
  return filename.slice(0, filename.length - ext.length);
}

/**
 * Resolves a normalized relative path to an actual key present in `keys`,
 * fuzzily, in increasing order of leniency:
 *
 *   1. Exact match.
 *   2. Sibling image extension — swaps a mismatched extension (.png → .jpg)
 *      or appends one when the stored value has none.
 *   3. Same-folder file whose basename (ignoring extension and case) matches —
 *      catches odd/non-listed extensions and case differences.
 *   4. Same-folder file whose basename *starts with* the stored stem, but only
 *      when exactly one such object exists — recovers truncated names (e.g. a
 *      stored "...-17818167" pointing at the real "...-1781816765133.jpg")
 *      without ever guessing between ambiguous candidates.
 *
 * Returns the matching key, or null when nothing in the bucket fits.
 */
// A stored stem must be at least this long before we'll treat it as a unique
// prefix of a real object, to avoid matching on trivially short fragments.
const MIN_PREFIX_STEM_LENGTH = 6;

export function resolveImageKey(
  relative: string,
  keys: Set<string>
): string | null {
  if (!relative) return null;

  // 1. Exact key.
  if (keys.has(relative)) return relative;

  // 2. Swap/append a sibling image extension.
  const withExt = resolveFileLocationWithFallback(relative, (p) => keys.has(p));
  if (withExt !== relative && keys.has(withExt)) return withExt;

  // 3/4. Same-folder matching by basename stem (case-insensitive).
  const slash = relative.lastIndexOf("/");
  const dir = slash >= 0 ? relative.slice(0, slash + 1) : "";
  const stem = basenameStem(relative.slice(slash + 1)).toLowerCase();
  if (!stem) return null;

  const exactMatches: string[] = [];
  const prefixMatches: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(dir)) continue;
    const rest = key.slice(dir.length);
    if (rest.includes("/")) continue; // restrict to the same folder
    const keyStem = basenameStem(rest).toLowerCase();
    if (keyStem === stem) {
      exactMatches.push(key);
    } else if (
      stem.length >= MIN_PREFIX_STEM_LENGTH &&
      keyStem.startsWith(stem)
    ) {
      prefixMatches.push(key);
    }
  }

  // 3. Prefer exact stem matches, choosing a canonical extension for determinism.
  if (exactMatches.length > 0) {
    if (exactMatches.length === 1) return exactMatches[0];
    for (const alt of IMAGE_EXT_FALLBACKS) {
      const hit = exactMatches.find(
        (k) => path.extname(k).toLowerCase() === alt
      );
      if (hit) return hit;
    }
    return exactMatches[0];
  }

  // 4. Fall back to a unique prefix match (recovers truncated names). Bail when
  //    ambiguous so we never serve the wrong image.
  if (prefixMatches.length === 1) return prefixMatches[0];

  return null;
}
