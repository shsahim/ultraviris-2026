import "server-only";
import { query } from "@/lib/db";
import { assertValidTable, escapeId } from "@/lib/admin-db";
import { resolveImage } from "@/lib/resolve-image";
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

// NOTE: the loaders passed to `cached()` deliberately let errors propagate so a
// transient DB/SSH failure is NOT stored in the cache for the full TTL. The
// outer try/catch keeps pages rendering (empty) on failure, and the next
// request retries the load.
export async function getActiveProjects(): Promise<Project[]> {
  try {
    return await cached("projects:active", () =>
      query<Project>(
        "SELECT id, name, table_name FROM active_projects WHERE is_active = 1 ORDER BY name"
      )
    );
  } catch {
    return [];
  }
}

export async function getProjectById(id: string): Promise<Project | null> {
  const projects = await getActiveProjects();
  return projects.find((p) => String(p.id) === String(id)) ?? null;
}

export async function getGalleryImages(
  tableName: string
): Promise<GalleryImage[]> {
  try {
    return await cached(`gallery:${tableName}`, async () => {
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
    });
  } catch {
    return [];
  }
}

export async function getAboutEntries(): Promise<AboutEntry[]> {
  try {
    return await cached("about:entries", () =>
      query<AboutEntry>(
        `SELECT id, month, day, year, about_title, about_content
         FROM about_table
         WHERE active = 1
         ORDER BY year DESC, CAST(month AS UNSIGNED) DESC, day DESC`
      )
    );
  } catch {
    return [];
  }
}

export async function getHomeImages(): Promise<HomeImage[]> {
  try {
    return await cached("home:brain_juice", async () => {
      const rows = await query<{ id: number; File_Location: string }>(
        "SELECT id, File_Location FROM brain_juice WHERE is_active = 1"
      );
      return Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          src: await resolveImage(r.File_Location),
        }))
      );
    });
  } catch {
    return [];
  }
}
