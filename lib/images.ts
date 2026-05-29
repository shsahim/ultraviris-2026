/**
 * Resolves a `File_Location` value from the database into a browser-usable
 * image `src`.
 *
 * Today, images live locally in the app's `public/` directory, so a stored
 * value like "brain_juice/img1.jpg" maps to "/brain_juice/img1.jpg".
 *
 * Later, when files move to S3, set IMAGE_BASE_URL to your bucket/CDN base
 * (e.g. "https://my-bucket.s3.amazonaws.com") and the same stored values will
 * resolve to full S3 URLs — no other code changes required.
 */
export function resolveImageSrc(fileLocation: string): string {
  const value = (fileLocation ?? "").trim();

  // Already an absolute URL (e.g. a public S3/CDN link) — use as-is.
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  // Normalize to a path without a leading slash.
  const relative = value.replace(/^\.?\/+/, "");

  const baseUrl = process.env.IMAGE_BASE_URL?.replace(/\/+$/, "");
  if (baseUrl) {
    return `${baseUrl}/${relative}`;
  }

  // Served from the local `public/` directory.
  return `/${relative}`;
}
