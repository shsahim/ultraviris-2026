import "server-only";
import { access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  GetSendQuotaCommand,
  SESClient,
} from "@aws-sdk/client-ses";
import { HeadBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { query } from "@/lib/db";
import { escapeId, listTables } from "@/lib/admin-db";
import {
  imageExistsWithFallback,
  normalizeFileLocation,
  resolveImageKey,
  toImageUrl,
} from "@/lib/image-resolve";
import { getS3Client, isS3Enabled, listS3ImageKeys } from "@/lib/storage";
import { checkGitHubAccess, getIssueRepo } from "@/lib/github";

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

export interface PublicImageHealth {
  applicable: boolean;
  ok: boolean;
  status: number | null;
  sampleUrl: string | null;
  message: string;
}

export interface GitHubHealth {
  configured: boolean;
  ok: boolean;
  repo: string;
  message: string;
}

export interface ConfigVar {
  name: string;
  set: boolean;
  required: boolean;
}

export interface ConfigHealth {
  ok: boolean;
  missingRequired: string[];
  vars: ConfigVar[];
}

export interface RuntimeHealth {
  nodeVersion: string;
  uptimeSeconds: number;
  memoryRssMb: number;
  memoryHeapUsedMb: number;
  version: string | null;
  environment: string;
}

export interface SiteHealth {
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
  tables: TableCount[];
  email: EmailHealth;
  storage: StorageHealth;
  images: ImageHealth;
  publicImages: PublicImageHealth;
  github: GitHubHealth;
  config: ConfigHealth;
  runtime: RuntimeHealth;
  checkedAt: string;
}

const PUBLIC_DIR = path.join(process.cwd(), "public");
const MAX_BROKEN_LISTED = 50;

function localImageExists(fileLocation: string): boolean {
  return imageExistsWithFallback(fileLocation, (relative) =>
    existsSync(path.join(PUBLIC_DIR, relative))
  );
}

// Mirror the runtime renderer (resolveImageDetailed -> resolveImageKey) so the
// health card flags an image as broken only when the page would actually fail to
// resolve it — not merely when the stored key isn't an exact/extension match.
function s3KeyExists(keys: Set<string>, fileLocation: string): boolean {
  return resolveImageKey(normalizeFileLocation(fileLocation), keys) !== null;
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
      const client = getS3Client();
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

  try {
    // Build the existence predicate for the active storage backend. For S3 we
    // index the bucket once (list its keys) and check membership; locally we
    // stat the public/ directory.
    let imageExists: (file: string) => boolean;
    if (mode === "s3") {
      const keys = await withTimeout(listS3ImageKeys(), 8000, "S3 list");
      imageExists = (file) => s3KeyExists(keys, file);
    } else {
      imageExists = (file) => localImageExists(file);
    }

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
        if (file && imageExists(file)) {
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

// Fetches a sample object key from S3 (skipping .DS_Store noise) so the public
// URL probe targets a real artwork file.
async function sampleS3Key(): Promise<string | null> {
  const client = getS3Client();
  const res = await client.send(
    new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, MaxKeys: 25 })
  );
  for (const obj of res.Contents ?? []) {
    if (obj.Key && !obj.Key.endsWith("/") && !obj.Key.includes(".DS_Store")) {
      return obj.Key;
    }
  }
  return null;
}

// Confirms images are actually reachable over HTTP at IMAGE_BASE_URL — the way
// browsers fetch them. A 403 means the bucket/CDN isn't publicly readable; a
// 404 means stored keys don't match real objects. This is the check that most
// directly explains "the image is broken in the browser".
async function checkPublicImageHealth(): Promise<PublicImageHealth> {
  const baseUrl = process.env.IMAGE_BASE_URL?.replace(/\/+$/, "");
  if (!isS3Enabled() || !baseUrl) {
    return {
      applicable: false,
      ok: true,
      status: null,
      sampleUrl: null,
      message: !baseUrl
        ? "IMAGE_BASE_URL not set — images are served locally."
        : "S3 not enabled — images are served locally.",
    };
  }

  try {
    const key = await withTimeout(sampleS3Key(), 5000, "S3 sample");
    if (!key) {
      return {
        applicable: true,
        ok: false,
        status: null,
        sampleUrl: null,
        message: "No objects found in the bucket to probe.",
      };
    }
    const sampleUrl = toImageUrl(baseUrl, key);
    // AbortSignal.timeout actually cancels the request (and frees the socket)
    // on a slow host, unlike a Promise.race wrapper which would leave it open.
    const res = await fetch(sampleUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    const ok = res.ok;
    let message: string;
    if (ok) {
      message = "Public image URLs are reachable (HTTP 200).";
    } else if (res.status === 403) {
      message =
        "Forbidden (403): the bucket/CDN is not publicly readable. Apply a public-read policy or serve via CloudFront/presigned URLs.";
    } else if (res.status === 404) {
      message =
        "Not found (404): stored File_Location values don't match real object keys (often an extension mismatch).";
    } else {
      message = `Unexpected HTTP ${res.status} from the image host.`;
    }
    return { applicable: true, ok, status: res.status, sampleUrl, message };
  } catch (error) {
    return {
      applicable: true,
      ok: false,
      status: null,
      sampleUrl: null,
      message:
        error instanceof Error ? error.message : "Could not probe image URL.",
    };
  }
}

async function checkGitHubHealth(): Promise<GitHubHealth> {
  const repo = getIssueRepo();
  if (!process.env.GITHUB_TOKEN) {
    return {
      configured: false,
      ok: false,
      repo,
      message: "GITHUB_TOKEN not set — the issue reporter is disabled.",
    };
  }
  const access = await checkGitHubAccess();
  return { configured: true, ok: access.ok, repo, message: access.message };
}

// Presence-only config audit (never reads secret values). `required` flags the
// vars the app needs to function correctly in production.
function getConfigHealth(): ConfigHealth {
  const spec: Array<{ name: string; required: boolean }> = [
    { name: "MYSQL_HOST", required: true },
    { name: "MYSQL_DATABASE", required: true },
    { name: "ADMIN_SESSION_SECRET", required: true },
    { name: "SES_FROM_EMAIL", required: true },
    { name: "S3_BUCKET", required: true },
    { name: "IMAGE_BASE_URL", required: true },
    { name: "HEALTH_CHECK_SECRET", required: false },
    { name: "GITHUB_TOKEN", required: false },
    { name: "CONTACT_TO_EMAIL", required: false },
  ];
  const vars: ConfigVar[] = spec.map(({ name, required }) => ({
    name,
    required,
    set: Boolean(process.env[name] && process.env[name] !== ""),
  }));
  const missingRequired = vars
    .filter((v) => v.required && !v.set)
    .map((v) => v.name);
  return { ok: missingRequired.length === 0, missingRequired, vars };
}

function getRuntimeHealth(): RuntimeHealth {
  const mem = process.memoryUsage();
  return {
    nodeVersion: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memoryRssMb: Math.round(mem.rss / 1024 / 1024),
    memoryHeapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    version:
      process.env.IMAGE_TAG ??
      process.env.GIT_COMMIT ??
      process.env.npm_package_version ??
      null,
    environment: process.env.NODE_ENV ?? "development",
  };
}

// SES/S3/GitHub results are cached for a short window; the DB check stays live.
const getEmailHealth = cached(EXTERNAL_CHECK_TTL_MS, checkEmailHealth);
const getStorageHealth = cached(EXTERNAL_CHECK_TTL_MS, checkStorageHealth);
const getImageHealth = cached(EXTERNAL_CHECK_TTL_MS, checkImageHealth);
const getPublicImageHealth = cached(
  EXTERNAL_CHECK_TTL_MS,
  checkPublicImageHealth
);
const getGitHubHealth = cached(EXTERNAL_CHECK_TTL_MS, checkGitHubHealth);

export async function getSiteHealth(): Promise<SiteHealth> {
  const checkedAt = new Date().toISOString();
  const [db, email, storage, images, publicImages, github] = await Promise.all([
    getDbHealth(),
    getEmailHealth(),
    getStorageHealth(),
    getImageHealth(),
    getPublicImageHealth(),
    getGitHubHealth(),
  ]);

  return {
    ok: db.ok,
    error: db.error,
    latencyMs: db.latencyMs,
    tables: db.tables,
    email,
    storage,
    images,
    publicImages,
    github,
    config: getConfigHealth(),
    runtime: getRuntimeHealth(),
    checkedAt,
  };
}
