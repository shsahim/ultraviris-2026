/**
 * One-time fix: update File_Location in the DB when the stored extension
 * (.png) does not match the file on disk (.jpg), etc.
 *
 * Usage (from repo root, with .env.local or Secrets Manager-backed env):
 *   npx tsx scripts/fix-file-locations.mts
 *   npx tsx scripts/fix-file-locations.mts --dry-run
 */
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { query } = await import("../lib/db");

const PUBLIC = path.join(process.cwd(), "public");
const EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const dryRun = process.argv.includes("--dry-run");

function resolveLocalPath(fileLocation: string): string | null {
  const relative = fileLocation.replace(/^\.?\/+/, "").trim();
  if (!relative) return null;
  if (existsSync(path.join(PUBLIC, relative))) return relative;

  const ext = path.extname(relative);
  const base = relative.slice(0, relative.length - ext.length);
  for (const alt of EXTS) {
    if (alt === ext.toLowerCase()) continue;
    const candidate = base + alt;
    if (existsSync(path.join(PUBLIC, candidate))) return candidate;
  }
  return null;
}

const tables = await query<{ table: string }>(
  `SELECT TABLE_NAME AS \`table\` FROM information_schema.columns
   WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'File_Location'`
);

let updated = 0;
let missing = 0;

for (const { table } of tables) {
  const rows = await query<{ id: number; File_Location: string }>(
    `SELECT id, File_Location FROM \`${table}\``
  );
  for (const row of rows) {
    const stored = (row.File_Location ?? "").trim();
    if (!stored) continue;
    const resolved = resolveLocalPath(stored);
    if (!resolved) {
      missing++;
      console.log(`[missing] ${table}#${row.id}: ${stored}`);
      continue;
    }
    if (resolved !== stored) {
      console.log(`[fix] ${table}#${row.id}: ${stored} → ${resolved}`);
      if (!dryRun) {
        await query(
          `UPDATE \`${table}\` SET File_Location = ? WHERE id = ?`,
          [resolved, row.id]
        );
      }
      updated++;
    }
  }
}

console.log(
  dryRun ? `[dry-run] would update ${updated}, missing ${missing}` : `Updated ${updated}, still missing ${missing}`
);
process.exit(0);
