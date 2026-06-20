import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  normalizeFileLocation,
  resolveFileLocationWithFallback,
  resolveImageKey,
} from "@/lib/image-resolve";
import { resolveRemoteImagePath } from "@/lib/image-probe";
import { cached } from "@/lib/cache";
import { isS3Enabled, listS3ImageKeys } from "@/lib/storage";
import { healFileLocation } from "@/lib/image-heal";

const PUBLIC_DIR = path.join(process.cwd(), "public");

function remoteRelativePath(fileLocation: string, baseUrl: string): string | null {
  const trimmed = (fileLocation ?? "").trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const prefix = `${baseUrl}/`;
    return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : null;
  }
  return normalizeFileLocation(fileLocation);
}

/**
 * Re-renders a resolved relative path back into the *stored* File_Location
 * format of the original value, so a self-healed DB row keeps its existing
 * convention (full URL, leading-slash, or bare relative path).
 */
function formatStoredLocation(
  resolvedRelative: string,
  original: string,
  baseUrl?: string
): string {
  const trimmed = original.trim();
  if (baseUrl && /^https?:\/\//i.test(trimmed)) {
    return `${baseUrl}/${resolvedRelative}`;
  }
  if (trimmed.startsWith("/")) return `/${resolvedRelative}`;
  return resolvedRelative;
}

export interface ResolvedImage {
  /** Browser-usable image src. */
  src: string;
  /**
   * When set, the stored File_Location was a fuzzy match (wrong/absent
   * extension, etc.) and should be rewritten to this value to fix it for next
   * time. Already formatted to match the original's convention.
   */
  correctedLocation?: string;
}

/**
 * Resolves a File_Location to a browser src, fuzzily matching against S3 keys
 * (or the local filesystem) and reporting a corrected stored value when the
 * match differs from what was stored.
 */
export async function resolveImageDetailed(
  fileLocation: string
): Promise<ResolvedImage> {
  const trimmed = (fileLocation ?? "").trim();
  const baseUrl = process.env.IMAGE_BASE_URL?.replace(/\/+$/, "");

  if (baseUrl) {
    const relative = remoteRelativePath(fileLocation, baseUrl);
    if (relative === null) {
      return { src: trimmed };
    }

    if (isS3Enabled()) {
      const keys = await cached("s3:image-keys", listS3ImageKeys);
      if (keys.size > 0) {
        const resolvedKey = resolveImageKey(relative, keys);
        if (resolvedKey) {
          return {
            src: `${baseUrl}/${resolvedKey}`,
            correctedLocation:
              resolvedKey !== relative
                ? formatStoredLocation(resolvedKey, trimmed, baseUrl)
                : undefined,
          };
        }
        // Not found in the listing — fall through to a HEAD probe below.
      }
    }

    const resolved = await resolveRemoteImagePath(baseUrl, relative);
    return {
      src: `${baseUrl}/${resolved}`,
      correctedLocation:
        resolved !== relative
          ? formatStoredLocation(resolved, trimmed, baseUrl)
          : undefined,
    };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { src: trimmed };
  }

  const relative = normalizeFileLocation(fileLocation);
  const resolved = resolveFileLocationWithFallback(relative, (p) =>
    existsSync(path.join(PUBLIC_DIR, p))
  );
  return {
    src: resolved ? `/${resolved}` : "/",
    correctedLocation:
      resolved !== relative ? formatStoredLocation(resolved, trimmed) : undefined,
  };
}

/** Resolves File_Location to a browser src (S3, local, extension fallback). */
export async function resolveImage(fileLocation: string): Promise<string> {
  return (await resolveImageDetailed(fileLocation)).src;
}

/** Runtime IMAGE_BASE_URL for passing into client admin components. */
export function getImageBaseUrl(): string {
  return process.env.IMAGE_BASE_URL?.replace(/\/+$/, "") ?? "";
}

/**
 * Map row id → resolved thumbnail src for File_Location columns. When `table`
 * is provided, fuzzy matches are written back to the database to self-heal the
 * stored value.
 */
export async function buildAdminImageSrcMap(
  rows: Record<string, unknown>[],
  columns: { name: string }[],
  primaryKey: string | null,
  table?: string
): Promise<Record<string, string>> {
  if (!primaryKey) return {};

  const fileCol = columns.find((c) => /file_location/i.test(c.name))?.name;
  if (!fileCol) return {};

  const map: Record<string, string> = {};
  await Promise.all(
    rows.map(async (row) => {
      const id = String(row[primaryKey] ?? "");
      const loc = row[fileCol];
      if (!id || loc == null || loc === "") return;
      const stored = String(loc);
      const { src, correctedLocation } = await resolveImageDetailed(stored);
      map[id] = src;
      if (table && correctedLocation && correctedLocation !== stored) {
        healFileLocation({
          table,
          idColumn: primaryKey,
          id,
          fileColumn: fileCol,
          corrected: correctedLocation,
        });
      }
    })
  );
  return map;
}
