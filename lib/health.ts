import "server-only";
import { access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  GetSendQuotaCommand,
  SESClient,
} from "@aws-sdk/client-ses";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { query } from "@/lib/db";
import { escapeId, listTables } from "@/lib/admin-db";
import { isS3Enabled } from "@/lib/storage";

export interface TableCount {
  table: string;
  count: number;
  activeCount: number | null;
}

export interface DbHealth {
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
  tables: TableCount[];
}

export interface EmailHealth {
  status: "ok" | "not_configured" | "error";
  message: string;
  max24Hour: number | null;
  sentLast24Hours: number | null;
}

export interface StorageHealth {
  mode: "s3" | "local";
  ok: boolean;
  message: string;
}

export interface BrokenImage {
  table: string;
  id: string;
  path: string;
}

export interface ImageHealth {
  mode: "s3" | "local";
  checked: number;
  ok: number;
  broken: number;
  brokenList: BrokenImage[];
  skipped: boolean;
  message: string;
}

export interface SiteHealth {
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
  tables: TableCount[];
  email: EmailHealth;
  storage: StorageHealth;
  images: ImageHealth;
  checkedAt: string;
}

const PUBLIC_DIR = path.join(process.cwd(), "public");
const IMAGE_EXT_FALLBACKS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const MAX_BROKEN_LISTED = 50;

// Mirrors lib/data.ts resolveImage: true if the file exists locally, allowing
// a sibling with the same basename but a different image extension.
function localImageExists(fileLocation: string): boolean {
  const relative = fileLocation.replace(/^\.?\/+/, "").trim();
  if (!relative) return false;
  if (existsSync(path.join(PUBLIC_DIR, relative))) return true;

  const ext = path.extname(relative);
  const base = relative.slice(0, relative.length - ext.length);
  return IMAGE_EXT_FALLBACKS.some(
    (alt) =>
      alt !== ext.toLowerCase() &&
      existsSync(path.join(PUBLIC_DIR, base + alt))
  );
}

// Caps a slow external call so the health page never hangs on it.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    ),
  ]);
}

const EXTERNAL_CHECK_TTL_MS = 60_000;

// Caches the result of an (expensive, external) check for a short window so
// the admin page stays snappy and doesn't hit AWS on every load.
function cached<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let entry: { value: T; expiresAt: number } | null = null;
  let inFlight: Promise<T> | null = null;

  return async () => {
    const now = Date.now();
    if (entry && entry.expiresAt > now) {
      return entry.value;
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = fn()
      .then((value) => {
        entry = { value, expiresAt: Date.now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

async function getDbHealth(): Promise<DbHealth> {
  try {
    const start = Date.now();
    await query("SELECT 1");
    const latencyMs = Date.now() - start;

    const tables = await listTables();

    // Which tables have an is_active column (single query).
    const activeColRows = await query<{ name: string }>(
      `SELECT TABLE_NAME AS name FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'is_active'`
    );
    const hasActive = new Set(activeColRows.map((r) => r.name));

    const counts = await Promise.all(
      tables.map(async (table) => {
        const escTable = escapeId(table);
        if (hasActive.has(table)) {
          const rows = await query<{ count: number; active: number }>(
            `SELECT COUNT(*) AS count,
                    SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active
             FROM ${escTable}`
          );
          return {
            table,
            count: Number(rows[0]?.count ?? 0),
            activeCount: Number(rows[0]?.active ?? 0),
          };
        }
        const rows = await query<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${escTable}`
        );
        return {
          table,
          count: Number(rows[0]?.count ?? 0),
          activeCount: null,
        };
      })
    );

    return { ok: true, error: null, latencyMs, tables: counts };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Database error",
      latencyMs: null,
      tables: [],
    };
  }
}

async function checkEmailHealth(): Promise<EmailHealth> {
  if (!process.env.SES_FROM_EMAIL) {
    return {
      status: "not_configured",
      message: "SES_FROM_EMAIL is not set — the contact form can't send email.",
      max24Hour: null,
      sentLast24Hours: null,
    };
  }
  try {
    const client = new SESClient({
      region: process.env.AWS_REGION ?? "us-west-2",
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
    const quota = await withTimeout(
      client.send(new GetSendQuotaCommand({})),
      4000,
      "SES"
    );
    const max24Hour = quota.Max24HourSend ?? 0;
    // SES sandbox accounts have a 200/day quota by default.
    const likelySandbox = max24Hour > 0 && max24Hour <= 200;
    return {
      status: "ok",
      message: likelySandbox
        ? "Connected (likely still in the SES sandbox — verify recipients)."
        : "Connected.",
      max24Hour,
      sentLast24Hours: quota.SentLast24Hours ?? 0,
    };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error ? error.message : "Could not reach Amazon SES.",
      max24Hour: null,
      sentLast24Hours: null,
    };
  }
}

async function checkStorageHealth(): Promise<StorageHealth> {
  if (isS3Enabled()) {
    try {
      const client = new S3Client({
        region: process.env.AWS_REGION ?? "us-west-2",
        credentials:
          process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
      });
      await withTimeout(
        client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET })),
        4000,
        "S3"
      );
      return {
        mode: "s3",
        ok: true,
        message: `S3 bucket "${process.env.S3_BUCKET}" is reachable.`,
      };
    } catch (error) {
      return {
        mode: "s3",
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : `S3 bucket "${process.env.S3_BUCKET}" is not reachable.`,
      };
    }
  }

  // Local mode: confirm the public directory is writable for uploads.
  try {
    await access(path.join(process.cwd(), "public"), constants.W_OK);
    return {
      mode: "local",
      ok: true,
      message: "Storing uploads locally in public/ (set S3_BUCKET for production).",
    };
  } catch {
    return {
      mode: "local",
      ok: false,
      message: "Local public/ directory is not writable.",
    };
  }
}

async function checkImageHealth(): Promise<ImageHealth> {
  const mode: "s3" | "local" = isS3Enabled() ? "s3" : "local";

  // Per-image verification only runs against the local public/ directory.
  if (mode === "s3") {
    return {
      mode,
      checked: 0,
      ok: 0,
      broken: 0,
      brokenList: [],
      skipped: true,
      message: "Images are served from S3; per-image verification runs in local mode.",
    };
  }

  try {
    // Find which image-bearing tables have File_Location / is_active columns.
    const colRows = await query<{ table: string; col: string }>(
      `SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS col
       FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE()
         AND COLUMN_NAME IN ('File_Location', 'is_active')`
    );
    const hasFile = new Set<string>();
    const hasActive = new Set<string>();
    for (const r of colRows) {
      if (r.col === "File_Location") hasFile.add(r.table);
      if (r.col === "is_active") hasActive.add(r.table);
    }

    let checked = 0;
    let ok = 0;
    const brokenList: BrokenImage[] = [];

    for (const table of hasFile) {
      const escTable = escapeId(table);
      const where = hasActive.has(table) ? "WHERE is_active = 1" : "";
      let rows: Array<{ id: unknown; File_Location: unknown }>;
      try {
        rows = await query<{ id: unknown; File_Location: unknown }>(
          `SELECT id, File_Location FROM ${escTable} ${where}`
        );
      } catch {
        // Table lacks an `id` column or is otherwise odd — skip it.
        continue;
      }

      for (const row of rows) {
        checked++;
        const file = String(row.File_Location ?? "").trim();
        if (file && localImageExists(file)) {
          ok++;
        } else if (brokenList.length < MAX_BROKEN_LISTED) {
          brokenList.push({
            table,
            id: String(row.id ?? "?"),
            path: file || "(empty)",
          });
        }
      }
    }

    const broken = checked - ok;
    return {
      mode,
      checked,
      ok,
      broken,
      brokenList,
      skipped: false,
      message:
        broken === 0
          ? `All ${checked} active images load correctly.`
          : `${broken} of ${checked} active images are missing or broken.`,
    };
  } catch (error) {
    return {
      mode,
      checked: 0,
      ok: 0,
      broken: 0,
      brokenList: [],
      skipped: false,
      message:
        error instanceof Error ? error.message : "Could not verify images.",
    };
  }
}

// SES/S3 results are cached for a short window; the DB check stays live.
const getEmailHealth = cached(EXTERNAL_CHECK_TTL_MS, checkEmailHealth);
const getStorageHealth = cached(EXTERNAL_CHECK_TTL_MS, checkStorageHealth);
const getImageHealth = cached(EXTERNAL_CHECK_TTL_MS, checkImageHealth);

export async function getSiteHealth(): Promise<SiteHealth> {
  const checkedAt = new Date().toISOString();
  const [db, email, storage, images] = await Promise.all([
    getDbHealth(),
    getEmailHealth(),
    getStorageHealth(),
    getImageHealth(),
  ]);

  return {
    ok: db.ok,
    error: db.error,
    latencyMs: db.latencyMs,
    tables: db.tables,
    email,
    storage,
    images,
    checkedAt,
  };
}
