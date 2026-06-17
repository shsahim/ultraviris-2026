import "server-only";
import { query } from "@/lib/db";
import type { ColumnMeta, Row } from "@/lib/admin-types";

export type { ColumnMeta, Row } from "@/lib/admin-types";

/** Backtick-escapes a SQL identifier. Only ever used on schema-validated names. */
export function escapeId(identifier: string): string {
  return "`" + identifier.replace(/`/g, "``") + "`";
}

// MySQL identifier rules we enforce for user-created tables (defense in depth,
// since identifiers can't be parameterized).
const TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

export async function createTableLike(
  newTable: string,
  sourceTable = "brain_juice",
  options: { ifNotExists?: boolean } = {}
): Promise<void> {
  if (!TABLE_NAME_RE.test(newTable)) {
    throw new Error(
      "Table name must start with a letter and contain only letters, numbers, and underscores (max 63 characters)."
    );
  }
  await assertValidTable(sourceTable);

  const tables = await listTables();
  if (tables.includes(newTable)) {
    if (options.ifNotExists) {
      return;
    }
    throw new Error(`A table named "${newTable}" already exists.`);
  }

  await query(
    `CREATE TABLE ${escapeId(newTable)} LIKE ${escapeId(sourceTable)}`
  );
}

// Turns an arbitrary project name into a valid MySQL table identifier.
export function slugifyTableName(name: string): string {
  let slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) {
    slug = "project";
  }
  if (/^[0-9]/.test(slug)) {
    slug = `t_${slug}`;
  }
  return slug.slice(0, 63);
}

// Turns a table identifier into a friendly, title-cased display name.
// e.g. "brain_juice" -> "Brain Juice", "sculptures_and_installations" ->
// "Sculptures And Installations".
export function toFriendlyName(tableName: string): string {
  return tableName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Adds a row to active_projects for the given table if one doesn't already
// exist, using a friendly display name derived from the table name.
export async function ensureProjectEntry(tableName: string): Promise<void> {
  const existing = await query<{ id: number }>(
    "SELECT id FROM active_projects WHERE table_name = ? LIMIT 1",
    [tableName]
  );
  if (existing.length > 0) {
    return;
  }
  await query(
    "INSERT INTO active_projects (name, is_active, table_name) VALUES (?, 1, ?)",
    [toFriendlyName(tableName), tableName]
  );
}

export async function listTables(): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT TABLE_NAME AS name
     FROM information_schema.tables
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`
  );
  return rows.map((r) => r.name);
}

export async function assertValidTable(table: string): Promise<void> {
  const tables = await listTables();
  if (!tables.includes(table)) {
    throw new Error(`Unknown table: ${table}`);
  }
}

export async function getColumns(table: string): Promise<ColumnMeta[]> {
  await assertValidTable(table);
  const rows = await query<{
    name: string;
    dataType: string;
    nullable: string;
    columnKey: string;
    extra: string;
  }>(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS nullable,
            COLUMN_KEY AS columnKey, EXTRA AS extra
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows.map((r) => ({
    name: r.name,
    dataType: r.dataType,
    nullable: r.nullable === "YES",
    isPrimaryKey: r.columnKey === "PRI",
    isAutoIncrement: (r.extra ?? "").includes("auto_increment"),
  }));
}

export function getPrimaryKey(columns: ColumnMeta[]): string | null {
  return columns.find((c) => c.isPrimaryKey)?.name ?? null;
}

export function getActiveColumn(columns: ColumnMeta[]): string | null {
  return columns.find((c) => c.name.toLowerCase() === "is_active")?.name ?? null;
}

export interface TableData {
  rows: Row[];
  total: number;
}

export async function getRows(
  table: string,
  limit: number,
  offset: number
): Promise<TableData> {
  await assertValidTable(table);
  const escTable = escapeId(table);
  const rows = await query<Row>(
    `SELECT * FROM ${escTable} LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const countRows = await query<{ total: number }>(
    `SELECT COUNT(*) AS total FROM ${escTable}`
  );
  return { rows, total: Number(countRows[0]?.total ?? 0) };
}

function assertValidColumns(columns: ColumnMeta[], names: string[]): void {
  const valid = new Set(columns.map((c) => c.name));
  for (const name of names) {
    if (!valid.has(name)) {
      throw new Error(`Unknown column: ${name}`);
    }
  }
}

export async function updateRow(
  table: string,
  primaryKey: string,
  id: string,
  data: Record<string, unknown>
): Promise<void> {
  const columns = await getColumns(table);
  assertValidColumns(columns, [primaryKey, ...Object.keys(data)]);

  const entries = Object.entries(data).filter(([key]) => key !== primaryKey);
  if (entries.length === 0) {
    return;
  }

  const setClause = entries.map(([key]) => `${escapeId(key)} = ?`).join(", ");
  const params = [...entries.map(([, value]) => value), id];
  await query(
    `UPDATE ${escapeId(table)} SET ${setClause} WHERE ${escapeId(primaryKey)} = ?`,
    params
  );
}

export async function insertRow(
  table: string,
  data: Record<string, unknown>
): Promise<void> {
  const columns = await getColumns(table);
  const keys = Object.keys(data);
  assertValidColumns(columns, keys);
  if (keys.length === 0) {
    throw new Error("No values provided");
  }

  const colClause = keys.map((k) => escapeId(k)).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  const params = keys.map((k) => data[k]);
  await query(
    `INSERT INTO ${escapeId(table)} (${colClause}) VALUES (${placeholders})`,
    params
  );
}

export async function deleteRow(
  table: string,
  primaryKey: string,
  id: string
): Promise<void> {
  const columns = await getColumns(table);
  assertValidColumns(columns, [primaryKey]);
  await query(
    `DELETE FROM ${escapeId(table)} WHERE ${escapeId(primaryKey)} = ?`,
    [id]
  );
}

export async function setActive(
  table: string,
  primaryKey: string,
  id: string,
  active: boolean
): Promise<void> {
  const columns = await getColumns(table);
  const activeColumn = getActiveColumn(columns);
  if (!activeColumn) {
    throw new Error(`Table ${table} has no is_active column`);
  }
  assertValidColumns(columns, [primaryKey]);
  await query(
    `UPDATE ${escapeId(table)} SET ${escapeId(activeColumn)} = ? WHERE ${escapeId(
      primaryKey
    )} = ?`,
    [active ? 1 : 0, id]
  );
}
