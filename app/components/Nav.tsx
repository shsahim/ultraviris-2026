import Link from "next/link";
import { getActiveProjects } from "@/lib/data";
import WorkDropdown from "./WorkDropdown";

export default async function Nav() {
  const projects = await getActiveProjects();

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
      <Link href="/" style={{ color: "#000000", textDecoration: "none" }}>
        <h1 style={{ fontSize: "1.65rem", fontWeight: 400 }}>Natalie R Nathan</h1>
      </Link>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: "2rem",
          fontSize: "1.15rem",
        }}
      >
        <WorkDropdown projects={projects} />
        <Link
          href="/resume"
          style={{ color: "#000000", textDecoration: "none" }}
        >
          resume
        </Link>
        <Link
          href="/contact"
          style={{ color: "#000000", textDecoration: "none" }}
        >
          contact
        </Link>
      </nav>
    </header>
  );
}
