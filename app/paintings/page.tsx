import Nav from "../components/Nav";
import Footer from "../components/Footer";
import Gallery from "../components/Gallery";
import { getGalleryImages, getProjectById } from "@/lib/data";

export const dynamic = "force-dynamic";

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
