/**
 * Fix active_projects rows whose table_name does not match a real table.
 * Also links gallery tables that exist but have no active_projects entry.
 *
 * Usage:
 *   npx tsx scripts/fix-active-projects.mts              # dry-run (default)
 *   npx tsx scripts/fix-active-projects.mts --apply
 */
import { readFileSync } from "node:fs";

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

log("fix-active-projects: starting…");

for (const line of readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8").split(
  "\n"
)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const apply =
  process.argv.includes("--apply") || process.argv.includes("--write");
const dryRun = !apply;

if (dryRun) {
  log("=== DRY RUN — pass --apply to write changes ===\n");
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function suggestTable(
  missing: string,
  galleryTables: string[]
): string | null {
  if (galleryTables.includes(missing)) return missing;

  const target = normalize(missing);
  let best: string | null = null;
  let bestScore = 0;

  for (const table of galleryTables) {
    const candidate = normalize(table);
    if (candidate === target) return table;
    if (candidate.includes(target) || target.includes(candidate)) {
      const score = Math.min(candidate.length, target.length);
      if (score > bestScore) {
        best = table;
        bestScore = score;
      }
    }
  }

  return best;
}

const { connectDatabase, query, closePool, setDbProgress } = await import(
  "./lib/script-db"
);
setDbProgress(log);
await connectDatabase();

const allTables = (
  await query<{ name: string }>(
    `SELECT TABLE_NAME AS name FROM information_schema.tables
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
  )
).map((r) => r.name);

const galleryTables = (
  await query<{ table: string }>(
    `SELECT TABLE_NAME AS \`table\` FROM information_schema.columns
     WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'File_Location'`
  )
).map((r) => r.table);

const projects = await query<{
  id: number;
  name: string;
  table_name: string;
  is_active: number;
}>("SELECT id, name, table_name, is_active FROM active_projects ORDER BY id");

const linkedTables = new Set(projects.map((p) => p.table_name));
let fixed = 0;

for (const project of projects) {
  if (allTables.includes(project.table_name)) continue;

  const replacement = suggestTable(project.table_name, galleryTables);
  if (!replacement) {
    log(
      `[missing table] project #${project.id} "${project.name}" → ${project.table_name} (no replacement found)`
    );
    continue;
  }

  log(
    `[${dryRun ? "would fix" : "fixed"}] project #${project.id} "${project.name}": ${project.table_name} → ${replacement}`
  );
  if (!dryRun) {
    await query("UPDATE active_projects SET table_name = ? WHERE id = ?", [
      replacement,
      project.id,
    ]);
  }
  linkedTables.add(replacement);
  fixed++;
}

for (const table of galleryTables) {
  if (linkedTables.has(table)) continue;
  if (table === "active_projects") continue;

  const name = table
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  log(
    `[${dryRun ? "would add" : "added"}] active_projects entry for orphaned table "${table}" as "${name}"`
  );
  if (!dryRun) {
    await query(
      "INSERT INTO active_projects (name, is_active, table_name) VALUES (?, 1, ?)",
      [name, table]
    );
  }
  fixed++;
}

log(
  dryRun
    ? `\nDry run complete: ${fixed} change(s) proposed`
    : `\nDone: ${fixed} change(s) applied`
);

await closePool();
process.exit(0);
