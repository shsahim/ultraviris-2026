import Link from "next/link";

export default function Nav() {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "2rem",
        flexWrap: "wrap",
      }}
    >
      <Link
        href="/"
        style={{ color: "#000000", textDecoration: "none" }}
      >
        <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>ultraviris</h1>
      </Link>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: "2rem",
        }}
      >
        <Link href="/paintings" style={{ color: "#000000" }}>
          Paintings
        </Link>
        <Link href="/resume" style={{ color: "#000000" }}>
          resume
        </Link>
        <Link href="/contact" style={{ color: "#000000" }}>
          contact
        </Link>
      </nav>
    </header>
  );
}
