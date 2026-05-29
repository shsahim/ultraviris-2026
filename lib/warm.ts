import "server-only";
import {
  getAboutEntries,
  getActiveProjects,
  getGalleryImages,
  getHomeImages,
} from "@/lib/data";

// Preloads (and caches) the data the public pages need, so the first page
// loads don't pay the SSH-tunnelled database round-trip.
export async function warmCache(): Promise<void> {
  try {
    const projects = await getActiveProjects();
    await Promise.all([
      getHomeImages(),
      getAboutEntries(),
      ...projects.map((p) => getGalleryImages(p.table_name)),
    ]);
    console.log(
      `[warm] cached ${projects.length} project galleries + home + about`
    );
  } catch (error) {
    console.warn("[warm] cache warm-up failed (will load lazily):", error);
  }
}
