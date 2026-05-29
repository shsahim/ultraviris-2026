import Nav from "./components/Nav";
import Footer from "./components/Footer";
import { query } from "@/lib/db";
import { resolveImageSrc } from "@/lib/images";

export const dynamic = "force-dynamic";

interface BrainJuiceRow {
  ID: number;
  File_Location: string;
}

async function getRandomImage(): Promise<{
  row: BrainJuiceRow | null;
  error: string | null;
}> {
  try {
    const rows = await query<BrainJuiceRow>(
      "SELECT ID, File_Location FROM brain_juice WHERE is_active = 1 ORDER BY RAND() LIMIT 1"
    );
    return { row: rows[0] ?? null, error: null };
  } catch (error) {
    return {
      row: null,
      error: error instanceof Error ? error.message : "Failed to query the database.",
    };
  }
}

export default async function Home() {
  const { row, error } = await getRandomImage();

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
        {error && (
          <p style={{ fontSize: "0.9rem", color: "#b00020" }}>{error}</p>
        )}
        {!error && !row && (
          <p style={{ fontSize: "0.9rem", color: "#777777" }}>
            No active images found.
          </p>
        )}
        {row && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolveImageSrc(row.File_Location)}
            alt={`brain_juice #${row.ID}`}
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
