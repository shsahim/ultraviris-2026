import "server-only";
import path from "node:path";
import { cached } from "@/lib/cache";
import {
  IMAGE_EXT_FALLBACKS,
  normalizeFileLocation,
  toImageUrl,
} from "@/lib/image-resolve";

async function urlReachable(url: string): Promise<boolean> {
  return cached(`img:head:${url}`, async () => {
    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  });
}

/** HEAD-probes alternate extensions when listing S3 keys is unavailable. */
export async function resolveRemoteImagePath(
  baseUrl: string,
  fileLocation: string
): Promise<string> {
  const relative = normalizeFileLocation(fileLocation);
  if (!relative) return relative;

  const primary = toImageUrl(baseUrl, relative);
  if (await urlReachable(primary)) return relative;

  const ext = path.extname(relative);
  const base = relative.slice(0, relative.length - ext.length);
  for (const alt of IMAGE_EXT_FALLBACKS) {
    if (alt === ext.toLowerCase()) continue;
    const candidate = base + alt;
    if (await urlReachable(toImageUrl(baseUrl, candidate))) return candidate;
  }

  return relative;
}
