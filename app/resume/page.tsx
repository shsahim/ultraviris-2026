import Nav from "../components/Nav";
import Footer from "../components/Footer";

export default function Resume() {
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
      <section style={{ marginTop: "2rem", maxWidth: "640px" }}>
        <p style={{ marginTop: "1rem", lineHeight: 1.6 }}>
          Natalie-Rose Nathan is a Fine Artist, Professional Video Editor and
          Producer, Dancer, and Musician in Los Angeles, California. She
          received her BFA from Otis College of Art and Design
        </p>
      </section>
      <Footer />
    </main>
  );
}
