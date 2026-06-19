import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  normalizeFileLocation,
  resolveFileLocationWithFallback,
} from "@/lib/image-resolve";
import { resolveRemoteImagePath } from "@/lib/image-probe";
import { cached } from "@/lib/cache";
import { isS3Enabled, listS3ImageKeys } from "@/lib/storage";

const PUBLIC_DIR = path.join(process.cwd(), "public");

function remoteRelativePath(fileLocation: string, baseUrl: string): string | null {
  const trimmed = (fileLocation ?? "").trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const prefix = `${baseUrl}/`;
    return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : null;
  }
  return normalizeFileLocation(fileLocation);
}

/** Resolves File_Location to a browser src (S3, local, extension fallback). */
export async function resolveImage(fileLocation: string): Promise<string> {
  const trimmed = (fileLocation ?? "").trim();
  const baseUrl = process.env.IMAGE_BASE_URL?.replace(/\/+$/, "");

  if (baseUrl) {
    const relative = remoteRelativePath(fileLocation, baseUrl);
    if (relative === null) {
      return trimmed;
    }

    if (isS3Enabled()) {
      const keys = await cached("s3:image-keys", listS3ImageKeys);
      if (keys.size > 0) {
        const resolved = resolveFileLocationWithFallback(relative, (p) =>
          keys.has(p)
        );
        if (keys.has(resolved)) {
          return `${baseUrl}/${resolved}`;
        }
      }
    }

    const resolved = await resolveRemoteImagePath(baseUrl, relative);
    return `${baseUrl}/${resolved}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const relative = normalizeFileLocation(fileLocation);
  const resolved = resolveFileLocationWithFallback(relative, (p) =>
    existsSync(path.join(PUBLIC_DIR, p))
  );
  return resolved ? `/${resolved}` : "/";
}

/** Runtime IMAGE_BASE_URL for passing into client admin components. */
export function getImageBaseUrl(): string {
  return process.env.IMAGE_BASE_URL?.replace(/\/+$/, "") ?? "";
}

/** Map row id → resolved thumbnail src for File_Location columns. */
export async function buildAdminImageSrcMap(
  rows: Record<string, unknown>[],
  columns: { name: string }[],
  primaryKey: string | null
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
      map[id] = await resolveImage(String(loc));
    })
  );
  return map;
}
