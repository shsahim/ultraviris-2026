import { isAdminConfigured, isAuthed } from "@/lib/auth";
import {
  getActiveColumn,
  getColumns,
  getPrimaryKey,
  getRows,
  listTables,
  type ColumnMeta,
  type Row,
} from "@/lib/admin-db";
import { getSiteHealth } from "@/lib/health";
import { logoutAction } from "./actions";
import Footer from "../components/Footer";
import LoginForm from "./components/LoginForm";
import TableSelect from "./components/TableSelect";
import TableManager from "./components/TableManager";
import CreateTableForm from "./components/CreateTableForm";
import Toast from "./components/Toast";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

// Tables hidden from the "choose a table to manage" dropdown.
const HIDDEN_FROM_MANAGE = ["active_projects", "gallery_index", "index_cat"];

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string; page?: string; created?: string }>;
}) {
  if (!(await isAuthed())) {
    return (
      <main className="admin-main">
        <LoginForm configured={isAdminConfigured()} />
        <Footer />
      </main>
    );
  }

  const params = await searchParams;
  const health = await getSiteHealth();
  const tables = health.ok ? await listTables() : [];

  // active_projects has its own dedicated section above, so don't also render
  // it in the Manage data view.
  const selected =
    params.table &&
    tables.includes(params.table) &&
    params.table !== "active_projects"
      ? params.table
      : null;
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  let columns: ColumnMeta[] = [];
  let rows: Row[] = [];
  let total = 0;
  let primaryKey: string | null = null;
  let activeColumn: string | null = null;

  if (selected) {
    columns = await getColumns(selected);
    primaryKey = getPrimaryKey(columns);
    activeColumn = getActiveColumn(columns);
    const data = await getRows(selected, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    rows = data.rows;
    total = data.total;
  }

  const PROJECTS_TABLE = "active_projects";
  let projects: {
    columns: ColumnMeta[];
    rows: Row[];
    total: number;
    primaryKey: string | null;
    activeColumn: string | null;
  } | null = null;

  if (health.ok && tables.includes(PROJECTS_TABLE)) {
    const projectColumns = await getColumns(PROJECTS_TABLE);
    const projectData = await getRows(PROJECTS_TABLE, PAGE_SIZE, 0);
    projects = {
      columns: projectColumns,
      rows: projectData.rows,
      total: projectData.total,
      primaryKey: getPrimaryKey(projectColumns),
      activeColumn: getActiveColumn(projectColumns),
    };
  }

  return (
    <main className="admin-main">
      {params.created && (
        <Toast message={`Successfully created Table ${params.created}`} />
      )}
      <header className="admin-header">
        <h1 className="admin-title">ultraviris admin</h1>
        <form action={logoutAction}>
          <button className="admin-button admin-button--ghost" type="submit">
            Sign out
          </button>
        </form>
      </header>

      <section className="admin-section">
        <h2 className="admin-subtitle">Site Health</h2>

        <div className="admin-health-cards">
          <div className="admin-health-card">
            <div className="admin-health-card-head">
              <span
                className={`admin-status-dot ${
                  health.ok ? "admin-status-dot--ok" : "admin-status-dot--bad"
                }`}
                aria-hidden
              />
              <span className="admin-health-card-title">Database</span>
            </div>
            <strong>{health.ok ? "Connected" : "Not connected"}</strong>
            {health.ok && health.latencyMs !== null && (
              <span className="admin-muted">
                Response time: {health.latencyMs} ms
              </span>
            )}
            {health.error && (
              <span className="admin-note admin-note--error">
                {health.error}
              </span>
            )}
          </div>

          <div className="admin-health-card">
            <div className="admin-health-card-head">
              <span
                className={`admin-status-dot ${
                  health.email.status === "ok"
                    ? "admin-status-dot--ok"
                    : health.email.status === "not_configured"
                    ? "admin-status-dot--warn"
                    : "admin-status-dot--bad"
                }`}
                aria-hidden
              />
              <span className="admin-health-card-title">Email (SES)</span>
            </div>
            <strong>
              {health.email.status === "ok"
                ? "Ready"
                : health.email.status === "not_configured"
                ? "Not configured"
                : "Error"}
            </strong>
            <span className="admin-muted">{health.email.message}</span>
            {health.email.max24Hour !== null && (
              <span className="admin-muted">
                Sent today: {health.email.sentLast24Hours} / {health.email.max24Hour}
              </span>
            )}
          </div>

          <div className="admin-health-card">
            <div className="admin-health-card-head">
              <span
                className={`admin-status-dot ${
                  health.storage.ok
                    ? "admin-status-dot--ok"
                    : "admin-status-dot--bad"
                }`}
                aria-hidden
              />
              <span className="admin-health-card-title">Image storage</span>
            </div>
            <strong>{health.storage.mode === "s3" ? "Amazon S3" : "Local"}</strong>
            <span className="admin-muted">{health.storage.message}</span>
          </div>

          <div className="admin-health-card">
            <div className="admin-health-card-head">
              <span
                className={`admin-status-dot ${
                  health.images.skipped
                    ? "admin-status-dot--warn"
                    : health.images.broken === 0
                    ? "admin-status-dot--ok"
                    : "admin-status-dot--bad"
                }`}
                aria-hidden
              />
              <span className="admin-health-card-title">Images</span>
            </div>
            <strong>
              {health.images.skipped
                ? "Not verified"
                : health.images.broken === 0
                ? "All loading"
                : `${health.images.broken} broken`}
            </strong>
            <span className="admin-muted">{health.images.message}</span>
            {!health.images.skipped && health.images.checked > 0 && (
              <span className="admin-muted">
                {health.images.ok} / {health.images.checked} OK
              </span>
            )}
          </div>
        </div>

        {health.images.brokenList.length > 0 && (
          <details className="admin-broken-images">
            <summary>
              Show broken images ({health.images.broken})
            </summary>
            <table className="admin-table admin-broken-table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>ID</th>
                  <th>File_Location</th>
                </tr>
              </thead>
              <tbody>
                {health.images.brokenList.map((b) => (
                  <tr key={`${b.table}-${b.id}`}>
                    <td>{b.table}</td>
                    <td>{b.id}</td>
                    <td>{b.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {health.images.broken > health.images.brokenList.length && (
              <p className="admin-muted">
                Showing first {health.images.brokenList.length} of{" "}
                {health.images.broken}.
              </p>
            )}
          </details>
        )}

        {health.ok && (
          <>
            <h3 className="admin-subtitle admin-health-tables-title">Tables</h3>
            <ul className="admin-health-list">
              {health.tables.map((t) => (
                <li key={t.table}>
                  <span className="admin-muted">{t.table}</span>
                  <strong>
                    {t.count}
                    {t.activeCount !== null && (
                      <span className="admin-muted">
                        {" "}
                        ({t.activeCount} active)
                      </span>
                    )}
                  </strong>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="admin-muted admin-timestamp">
          Last checked {new Date(health.checkedAt).toLocaleString()}
        </p>
      </section>

      {projects && (
        <section className="admin-section">
          <h2 className="admin-subtitle admin-projects-title">
            Active Projects
          </h2>
          <TableManager
            table={PROJECTS_TABLE}
            columns={projects.columns}
            rows={projects.rows}
            primaryKey={projects.primaryKey}
            activeColumn={projects.activeColumn}
            total={projects.total}
            page={1}
            pageSize={PAGE_SIZE}
            showTitle={false}
            embedded
          />
        </section>
      )}

      <section className="admin-section">
        <h2 className="admin-subtitle">Manage data</h2>
        {!health.ok ? (
          <p className="admin-muted">
            Connect to the database to manage data.
          </p>
        ) : (
          <>
            <TableSelect
              tables={tables.filter((t) => !HIDDEN_FROM_MANAGE.includes(t))}
              selected={selected}
            />
            <div className="admin-divider" />
            <CreateTableForm />
          </>
        )}
      </section>

      {selected && (
        <TableManager
          table={selected}
          columns={columns}
          rows={rows}
          primaryKey={primaryKey}
          activeColumn={activeColumn}
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
        />
      )}
      <Footer />
    </main>
  );
}
