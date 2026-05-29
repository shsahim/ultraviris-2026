"use client";

import { useId, useState } from "react";
import { resolveImageSrc } from "@/lib/images";

export default function ImageUploadField({
  table,
  fieldName,
  label,
  initialValue,
}: {
  table: string;
  fieldName: string;
  label: string;
  initialValue: string;
}) {
  const inputId = useId();
  const [location, setLocation] = useState(initialValue ?? "");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

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

      {location && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolveImageSrc(location)}
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
