import Nav from "../components/Nav";
import Footer from "../components/Footer";
import ContactForm from "../components/ContactForm";

export default function Contact() {
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
        <h2 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "1rem" }}>
          contact
        </h2>
        <ContactForm />
      </section>
      <Footer />
    </main>
  );
}
