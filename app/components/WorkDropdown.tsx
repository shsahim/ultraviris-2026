import Link from "next/link";

export interface Project {
  id: number;
  name: string;
}

export default function WorkDropdown({ projects }: { projects: Project[] }) {
  return (
    <div className="work-dropdown">
      <span className="work-trigger" tabIndex={0} aria-haspopup="menu">
        work
      </span>
      <div className="work-menu" role="menu">
        {projects.length === 0 ? (
          <span className="work-menu-empty">No projects yet</span>
        ) : (
          projects.map((project) => (
            <Link
              key={project.id}
              href={`/paintings?project=${project.id}`}
              className="work-menu-item"
              role="menuitem"
            >
              {project.name}
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
