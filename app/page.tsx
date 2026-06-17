import Nav from "./components/Nav";
import Footer from "./components/Footer";
import FeaturedImage from "./components/FeaturedImage";
import { getHomeImages } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const images = await getHomeImages();
  // Shuffle so the featured image varies, then let the client show the first
  // that actually loads (skipping any missing from S3).
  const candidates = [...images]
    .sort(() => Math.random() - 0.5)
    .map((img) => ({ id: img.id, src: img.src, alt: `brain_juice #${img.id}` }));

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
      <section
        style={{
          marginTop: "2rem",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <FeaturedImage images={candidates} />
      </section>
      <Footer />
    </main>
  );
}
