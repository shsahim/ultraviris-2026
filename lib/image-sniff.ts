// Detects an image's real type from its leading "magic bytes" rather than
// trusting the client-supplied MIME type or filename, both of which are
// attacker-controlled. SVG is intentionally NOT recognized here: it's a text
// format that can carry scripts, so we don't accept it via this path.

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function asciiAt(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  return buf.toString("latin1", offset, offset + text.length) === text;
}

/**
 * Returns the detected image MIME type, or null if the bytes don't match a
 * supported raster image format.
 */
export function sniffImageType(buf: Buffer): string | null {
  // JPEG: FF D8 FF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  // GIF: "GIF87a" / "GIF89a"
  if (asciiAt(buf, 0, "GIF87a") || asciiAt(buf, 0, "GIF89a")) {
    return "image/gif";
  }

  // WebP: "RIFF"...."WEBP"
  if (asciiAt(buf, 0, "RIFF") && asciiAt(buf, 8, "WEBP")) {
    return "image/webp";
  }

  // BMP: "BM"
  if (asciiAt(buf, 0, "BM")) return "image/bmp";

  // TIFF: little-endian "II*\0" or big-endian "MM\0*"
  if (
    startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "image/tiff";
  }

  // ISO-BMFF (HEIC/AVIF): "ftyp" box at offset 4, brand at offset 8.
  if (asciiAt(buf, 4, "ftyp")) {
    const brand = buf.toString("latin1", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "heim", "heis", "hevc", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }

  return null;
}

/** True when the buffer's magic bytes identify it as a supported image. */
export function isSupportedImage(buf: Buffer): boolean {
  return sniffImageType(buf) !== null;
}
