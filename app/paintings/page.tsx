import Nav from "../components/Nav";
import Footer from "../components/Footer";

export default function Paintings() {
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
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 600 }}>Paintings</h2>
      </section>
      <Footer />
    </main>
  );
}
