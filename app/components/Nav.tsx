import Link from "next/link";
import { getActiveProjects } from "@/lib/data";
import WorkDropdown from "./WorkDropdown";

export default async function Nav() {
  const projects = await getActiveProjects();

  return (
    <header className="site-header">
      <Link href="/" className="site-brand">
        <h1 className="site-title">Natalie R Nathan</h1>
      </Link>
      <nav className="site-nav">
        <WorkDropdown projects={projects} />
        <Link href="/resume" className="site-nav-link">
          resume
        </Link>
        <Link href="/contact" className="site-nav-link">
          contact
        </Link>
      </nav>
    </header>
  );
}
