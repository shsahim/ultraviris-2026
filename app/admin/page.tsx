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

  const selected =
    params.table && tables.includes(params.table) ? params.table : null;
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
        </div>

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

      <section className="admin-section">
        <h2 className="admin-subtitle">Manage data</h2>
        {!health.ok ? (
          <p className="admin-muted">
            Connect to the database to manage data.
          </p>
        ) : (
          <>
            <TableSelect tables={tables} selected={selected} />
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
