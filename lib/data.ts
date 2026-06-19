import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { query } from "@/lib/db";
import { assertValidTable, escapeId } from "@/lib/admin-db";
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

// Resolves a stored File_Location to a browser src, tolerating extension
// mismatches (e.g. the DB says ".png" but the file in public/ or S3 is ".jpg")
// by falling back to a sibling with the same basename.
async function resolveImage(fileLocation: string): Promise<string> {
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

export interface Project {
  id: number;
  name: string;
  table_name: string;
}

export interface GalleryImage {
  id: number;
  title: string;
  src: string;
  description: string;
  width: number | null;
  height: number | null;
}

export interface AboutEntry {
  id: number;
  month: string | null;
  day: number | null;
  year: number | null;
  about_title: string | null;
  about_content: string | null;
}

export interface HomeImage {
  id: number;
  src: string;
}

export function getActiveProjects(): Promise<Project[]> {
  return cached("projects:active", async () => {
    try {
      return await query<Project>(
        "SELECT id, name, table_name FROM active_projects WHERE is_active = 1 ORDER BY name"
      );
    } catch {
      return [];
    }
  });
}

export async function getProjectById(id: string): Promise<Project | null> {
  const projects = await getActiveProjects();
  return projects.find((p) => String(p.id) === String(id)) ?? null;
}

export function getGalleryImages(tableName: string): Promise<GalleryImage[]> {
  return cached(`gallery:${tableName}`, async () => {
    try {
      await assertValidTable(tableName);
      const rows = await query<Record<string, unknown>>(
        `SELECT * FROM ${escapeId(tableName)} WHERE is_active = 1 ORDER BY id`
      );
      return Promise.all(
        rows.map(async (r) => {
          const file = (r.File_Location as string) ?? "";
          return {
            id: Number(r.id),
            title: (r.Title as string) ?? "",
            src: await resolveImage(file),
            description: (r.image_Description as string) ?? "",
            width: r.width != null ? Number(r.width) : null,
            height: r.height != null ? Number(r.height) : null,
          };
        })
      );
    } catch {
      return [];
    }
  });
}

export function getAboutEntries(): Promise<AboutEntry[]> {
  return cached("about:entries", async () => {
    try {
      return await query<AboutEntry>(
        `SELECT id, month, day, year, about_title, about_content
         FROM about_table
         WHERE active = 1
         ORDER BY year DESC, CAST(month AS UNSIGNED) DESC, day DESC`
      );
    } catch {
      return [];
    }
  });
}

export function getHomeImages(): Promise<HomeImage[]> {
  return cached("home:brain_juice", async () => {
    try {
      const rows = await query<{ id: number; File_Location: string }>(
        "SELECT id, File_Location FROM brain_juice WHERE is_active = 1"
      );
      return Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          src: await resolveImage(r.File_Location),
        }))
      );
    } catch {
      return [];
    }
  });
}
