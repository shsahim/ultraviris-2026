/**
 * Align File_Location values in the DB with objects that actually exist in S3.
 *
 * For each row, the script:
 *   1. Normalizes the stored path to an S3 key (handles leading slashes and
 *      full IMAGE_BASE_URL URLs).
 *   2. Tries the same path with alternate image extensions (.png → .jpg, etc.).
 *   3. If still missing, looks for a same-basename file under images/<table>/.
 *
 * Usage (from repo root, with .env.local or ENV_FILE):
 *   npx tsx scripts/fix-file-locations-s3.mts              # dry-run (default)
 *   npx tsx scripts/fix-file-locations-s3.mts --dry-run    # same as default
 *   npx tsx scripts/fix-file-locations-s3.mts --apply        # write changes to DB
 *   npx tsx scripts/fix-file-locations-s3.mts --table brain_juice
 *
 * Requires S3_BUCKET, AWS credentials, and database access (SSH tunnel if local).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  IMAGE_EXT_FALLBACKS,
  normalizeFileLocation,
  resolveFileLocationWithFallback,
} from "../lib/image-resolve";

/** Progress on stderr — unbuffered and visible even when stdout is piped. */
function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

log("fix-file-locations-s3: starting…");

const envFile = process.env.ENV_FILE ?? ".env.local";
log(`Loading env from ${envFile} …`);
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const apply =
  process.argv.includes("--apply") || process.argv.includes("--write");
const dryRun =
  !apply ||
  process.argv.includes("--dry-run") ||
  process.argv.includes("--dry") ||
  process.argv.includes("-n");
const tableArg = (() => {
  const i = process.argv.indexOf("--table");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

const bucket = process.env.S3_BUCKET;
if (!bucket) {
  console.error("S3_BUCKET is not set — nothing to check.");
  process.exit(1);
}

const baseUrl = process.env.IMAGE_BASE_URL?.replace(/\/+$/, "");
const region = process.env.AWS_REGION ?? "us-west-2";
const dbName = process.env.MYSQL_DATABASE ?? "(unset)";
const sshTunnel =
  process.env.DB_USE_SSH_TUNNEL !== undefined &&
  process.env.DB_USE_SSH_TUNNEL !== ""
    ? /^(1|true|yes|on)$/i.test(process.env.DB_USE_SSH_TUNNEL)
    : Boolean(process.env.SSH_HOST);

log(`S3 bucket: ${bucket} (${region})`);
log(`Database:  ${dbName}${sshTunnel ? " via SSH tunnel" : " (direct)"}`);
if (tableArg) log(`Table filter: ${tableArg}`);

if (dryRun) {
  log("");
  log("=== DRY RUN — no database changes will be made ===");
  log("Pass --apply to write updates.");
} else {
  log("");
  log("=== APPLY MODE — database rows will be updated ===");
}
log("");

async function listS3Keys(): Promise<Set<string>> {
  log(`Listing s3://${bucket} …`);
  const client = new S3Client({
    region,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  const keys = new Set<string>();
  let token: string | undefined;
  let page = 0;
  do {
    page++;
    log(`  S3 page ${page} …`);
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.add(obj.Key);
    }
    log(`  … ${keys.size} object(s) indexed so far`);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return keys;
}

function buildKeyIndex(keys: Set<string>): Map<string, string> {
  const byLower = new Map<string, string>();
  for (const key of keys) {
    byLower.set(key.toLowerCase(), key);
  }
  return byLower;
}

function storedToKey(stored: string): string {
  const trimmed = stored.trim();
  if (baseUrl && trimmed.startsWith(`${baseUrl}/`)) {
    return normalizeFileLocation(trimmed.slice(baseUrl.length));
  }
  return normalizeFileLocation(trimmed);
}

function keyExists(
  key: string,
  keys: Set<string>,
  byLower: Map<string, string>
): boolean {
  return keys.has(key) || byLower.has(key.toLowerCase());
}

function canonicalKey(
  key: string,
  keys: Set<string>,
  byLower: Map<string, string>
): string {
  if (keys.has(key)) return key;
  return byLower.get(key.toLowerCase()) ?? key;
}

function basenameStem(filename: string): string {
  const ext = path.extname(filename);
  return filename.slice(0, filename.length - ext.length).toLowerCase();
}

function findInTableFolder(
  table: string,
  storedKey: string,
  keys: Set<string>,
  byLower: Map<string, string>
): string | null {
  const prefix = `images/${table}/`;
  const storedBase = path.basename(storedKey).toLowerCase();
  const storedStem = basenameStem(storedBase);

  const matches: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const file = path.basename(key);
    const lower = file.toLowerCase();
    if (lower === storedBase) return canonicalKey(key, keys, byLower);
    if (basenameStem(lower) === storedStem) matches.push(key);
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  for (const alt of IMAGE_EXT_FALLBACKS) {
    const hit = matches.find((k) => path.extname(k).toLowerCase() === alt);
    if (hit) return hit;
  }
  return matches[0];
}

function resolveS3Key(
  table: string,
  stored: string,
  keys: Set<string>,
  byLower: Map<string, string>
): string | null {
  const key = storedToKey(stored);
  if (!key) return null;

  const exists = (candidate: string) =>
    keyExists(candidate, keys, byLower);

  if (exists(key)) {
    return canonicalKey(key, keys, byLower);
  }

  const withExt = resolveFileLocationWithFallback(key, exists);
  if (exists(withExt)) {
    return canonicalKey(withExt, keys, byLower);
  }

  return findInTableFolder(table, key, keys, byLower);
}

function formatStoredLocation(resolvedKey: string, original: string): string {
  const trimmed = original.trim();
  if (baseUrl && /^https?:\/\//i.test(trimmed)) {
    return `${baseUrl}/${resolvedKey}`;
  }
  if (trimmed.startsWith("/")) return `/${resolvedKey}`;
  return resolvedKey;
}

function storedMatchesResolved(
  stored: string,
  resolvedKey: string
): boolean {
  return storedToKey(stored) === resolvedKey;
}

try {
  const keys = await listS3Keys();
  const byLower = buildKeyIndex(keys);
  log(`S3 listing complete: ${keys.size} object(s).\n`);

  log("Connecting to database …");
  const { connectDatabase, query, closePool, setDbProgress } = await import(
    "./lib/script-db"
  );
  setDbProgress(log);
  await connectDatabase();
  log("");

  log("Finding tables with File_Location column …");
  let tables = await query<{ table: string }>(
    `SELECT TABLE_NAME AS \`table\` FROM information_schema.columns
     WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'File_Location'`
  );

  if (tableArg) {
    tables = tables.filter((t) => t.table === tableArg);
    if (tables.length === 0) {
      console.error(`No table named "${tableArg}" has a File_Location column.`);
      process.exit(1);
    }
  }

  log(`Scanning ${tables.length} table(s): ${tables.map((t) => t.table).join(", ")}\n`);

  let updated = 0;
  let ok = 0;
  let missing = 0;

  for (const { table } of tables) {
    log(`Table ${table}: loading rows …`);
    const rows = await query<{ id: number; File_Location: string }>(
      `SELECT id, File_Location FROM \`${table}\``
    );
    log(`Table ${table}: checking ${rows.length} row(s) …`);

    let tableUpdated = 0;
    let tableOk = 0;
    let tableMissing = 0;

    for (const row of rows) {
      const stored = (row.File_Location ?? "").trim();
      if (!stored) continue;

      const resolvedKey = resolveS3Key(table, stored, keys, byLower);
      if (!resolvedKey) {
        missing++;
        tableMissing++;
        log(`  [missing] #${row.id}: ${stored}`);
        continue;
      }

      if (storedMatchesResolved(stored, resolvedKey)) {
        ok++;
        tableOk++;
        continue;
      }

      const next = formatStoredLocation(resolvedKey, stored);
      const label = dryRun ? "would update" : "updated";
      log(`  [${label}] #${row.id}: ${stored} → ${next}`);
      if (!dryRun) {
        await query(`UPDATE \`${table}\` SET File_Location = ? WHERE id = ?`, [
          next,
          row.id,
        ]);
      }
      updated++;
      tableUpdated++;
    }

    log(
      `Table ${table}: done — ${tableUpdated} to change, ${tableOk} ok, ${tableMissing} missing\n`
    );
  }

  log(
    dryRun
      ? `Dry run complete: ${updated} row(s) would change, ${ok} already ok, ${missing} missing in S3`
      : `Done: updated ${updated}, ${ok} already ok, ${missing} still missing in S3`
  );

  if (dryRun && updated > 0) {
    log("Re-run with --apply to write these changes.");
  }

  await closePool();
  process.exit(missing > 0 ? 2 : 0);
} catch (err) {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
}
