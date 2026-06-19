"use client";

import { useId, useState } from "react";
import { resolveImageSrc } from "@/lib/images";

export default function ImageUploadField({
  table,
  fieldName,
  label,
  initialValue,
  imageBaseUrl = "",
  initialPreviewSrc,
}: {
  table: string;
  fieldName: string;
  label: string;
  initialValue: string;
  imageBaseUrl?: string;
  initialPreviewSrc?: string;
}) {
  const inputId = useId();
  const [location, setLocation] = useState(initialValue ?? "");
  const [previewSrc, setPreviewSrc] = useState(initialPreviewSrc ?? "");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const base = imageBaseUrl || undefined;

  function previewUrl(storedLocation: string, resolved?: string): string {
    if (resolved) return resolved;
    if (!storedLocation) return "";
    return resolveImageSrc(storedLocation, base);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("table", table);

      const res = await fetch("/api/admin/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.location) {
        throw new Error(data.error ?? "Upload failed.");
      }
      setLocation(data.location);
      setPreviewSrc(previewUrl(data.location));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const displaySrc = previewSrc || previewUrl(location);

  return (
    <div className="admin-field">
      <span className="admin-label">{label}</span>

      {/* The value actually submitted with the form. */}
      <input type="hidden" name={fieldName} value={location} />

      <div className="admin-upload">
        <label htmlFor={inputId} className="admin-button admin-button--ghost">
          {uploading ? "Uploading..." : location ? "Change image" : "Choose image"}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/*"
          onChange={handleFile}
          disabled={uploading}
          style={{ display: "none" }}
        />
        {location && !uploading && (
          <span className="admin-muted admin-upload-path">{location}</span>
        )}
      </div>

      {displaySrc && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={displaySrc}
          alt="preview"
          className="admin-upload-preview"
        />
      )}

      <p className="admin-muted admin-upload-help">
        Saved as <code>/images/{table}/&lt;filename&gt;</code> and uploaded to S3
        once enabled (stored locally until then).
      </p>

      {error && <p className="admin-note admin-note--error">{error}</p>}
    </div>
  );
}
