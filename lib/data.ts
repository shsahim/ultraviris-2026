import "server-only";
import { query } from "@/lib/db";
import { assertValidTable, escapeId } from "@/lib/admin-db";
import { resolveImageSrc } from "@/lib/images";
import { cached } from "@/lib/cache";

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
      return rows.map((r) => {
        const file = (r.File_Location as string) ?? "";
        return {
          id: Number(r.id),
          title: (r.Title as string) ?? "",
          src: resolveImageSrc(file),
          description: (r.image_Description as string) ?? "",
          width: r.width != null ? Number(r.width) : null,
          height: r.height != null ? Number(r.height) : null,
        };
      });
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
      return rows.map((r) => ({
        id: r.id,
        src: resolveImageSrc(r.File_Location),
      }));
    } catch {
      return [];
    }
  });
}
