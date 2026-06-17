import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export function isS3Enabled(): boolean {
  return Boolean(process.env.S3_BUCKET);
}

// Single place that builds the S3 client. Explicit env credentials win; when
// they're absent the SDK falls back to its default provider chain (shared
// ~/.aws config or an instance/role profile in AWS).
export function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-west-2",
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
}

// Lists every object key in the configured bucket, paginating through all
// results. Indexes the whole bucket (not just images/) so verification matches
// however File_Location values are laid out. Requires s3:ListBucket.
export async function listS3ImageKeys(): Promise<Set<string>> {
  const bucket = process.env.S3_BUCKET;
  const keys = new Set<string>();
  if (!bucket) return keys;

  const client = getS3Client();
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.add(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return keys;
}

function sanitizeFilename(original: string): string {
  const dot = original.lastIndexOf(".");
  const rawBase = dot > 0 ? original.slice(0, dot) : original;
  const rawExt = dot > 0 ? original.slice(dot + 1) : "";

  const base =
    rawBase
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "image";
  const ext = rawExt.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();

  // Add a timestamp so re-uploading a same-named file never overwrites.
  const stamped = `${base}-${Date.now()}`;
  return ext ? `${stamped}.${ext}` : stamped;
}

export interface SavedImage {
  /** Value to store in the database `File_Location` column. */
  location: string;
  /** Where it was stored ("s3" or "local"). */
  storage: "s3" | "local";
}

/**
 * Saves an uploaded image under `images/<table>/<filename>`.
 *
 * - If S3 is enabled (S3_BUCKET set), uploads to that bucket.
 * - Otherwise, writes to the local `public/` directory so the feature works
 *   today; the same File_Location resolves correctly once IMAGE_BASE_URL points
 *   at S3.
 */
export async function saveImage(
  table: string,
  originalName: string,
  body: Buffer,
  contentType: string
): Promise<SavedImage> {
  const filename = sanitizeFilename(originalName);
  const key = `images/${table}/${filename}`;
  const location = `/${key}`;

  if (isS3Enabled()) {
    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
    return { location, storage: "s3" };
  }

  const fullPath = path.join(process.cwd(), "public", key);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body);
  return { location, storage: "local" };
}
