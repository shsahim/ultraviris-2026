import type { Metadata } from "next";
import Nav from "../components/Nav";
import Footer from "../components/Footer";
import Gallery from "../components/Gallery";
import { getGalleryImages, getProjectById } from "@/lib/data";
import { SITE_NAME } from "@/lib/site";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const { project } = await searchParams;
  const info = project ? await getProjectById(project).catch(() => null) : null;
  const title = info?.name ?? "Work";
  const description = info?.name
    ? `${info.name} — a project by ${SITE_NAME}.`
    : `Selected paintings and projects by ${SITE_NAME}.`;
  // Point project galleries' canonical at the base Work page to avoid indexing
  // many near-duplicate query-string URLs.
  return {
    title,
    description,
    alternates: { canonical: "/paintings" },
    openGraph: { title: `${title} — ${SITE_NAME}`, description },
  };
}

export default async function Paintings({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  const projectInfo = project ? await getProjectById(project) : null;
  const images = projectInfo
    ? await getGalleryImages(projectInfo.table_name)
    : [];

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "2rem",
      }}
    >
      <Nav />
      <section style={{ marginTop: "2rem", flex: 1 }}>
        {!projectInfo ? (
          <p style={{ color: "#777777" }}>
            Select a project from the <strong>Work</strong> menu to view its
            gallery.
          </p>
        ) : (
          <>
            <h2
              style={{
                fontSize: "1.5rem",
                fontWeight: 400,
                marginBottom: "1.5rem",
              }}
            >
              {projectInfo.name}
            </h2>
            <Gallery images={images} projectName={projectInfo.name} />
          </>
        )}
      </section>
      <Footer />
    </main>
  );
}
