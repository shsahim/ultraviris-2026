import Nav from "./components/Nav";
import Footer from "./components/Footer";
import { getHomeImages } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const images = await getHomeImages();
  const row =
    images.length > 0
      ? images[Math.floor(Math.random() * images.length)]
      : null;

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
        {!row && (
          <p style={{ fontSize: "0.9rem", color: "#777777" }}>
            No active images found.
          </p>
        )}
        {row && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={row.src}
            alt={`brain_juice #${row.id}`}
            style={{
              maxWidth: "100%",
              maxHeight: "75vh",
              height: "auto",
              objectFit: "contain",
            }}
          />
        )}
      </section>
      <Footer />
    </main>
  );
}
