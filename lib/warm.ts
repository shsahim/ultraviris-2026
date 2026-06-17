import "server-only";

// Preloads (and caches) the data the public pages need, so the first page
// loads don't pay the SSH-tunnelled database round-trip.
// Invoked from lib/db.ts on first pool creation (not instrumentation.ts, which
// would pull ssh2 into Next's edge/browser instrumentation bundle).
export async function warmCache(): Promise<void> {
  try {
    const {
      getAboutEntries,
      getActiveProjects,
      getGalleryImages,
      getHomeImages,
    } = await import("@/lib/data");

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
