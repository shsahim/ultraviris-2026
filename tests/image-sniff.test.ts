import { describe, expect, it } from "vitest";

import { isSupportedImage, sniffImageType } from "@/lib/image-sniff";

function bytes(...b: number[]): Buffer {
  return Buffer.from(b);
}

describe("sniffImageType", () => {
  it("detects JPEG", () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    expect(
      sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    ).toBe("image/png");
  });

  it("detects GIF", () => {
    expect(sniffImageType(Buffer.from("GIF89a..."))).toBe("image/gif");
  });

  it("detects WebP", () => {
    const buf = Buffer.concat([
      Buffer.from("RIFF"),
      bytes(0, 0, 0, 0),
      Buffer.from("WEBP"),
    ]);
    expect(sniffImageType(buf)).toBe("image/webp");
  });

  it("detects AVIF and HEIC by ftyp brand", () => {
    const avif = Buffer.concat([bytes(0, 0, 0, 0), Buffer.from("ftypavif")]);
    const heic = Buffer.concat([bytes(0, 0, 0, 0), Buffer.from("ftypheic")]);
    expect(sniffImageType(avif)).toBe("image/avif");
    expect(sniffImageType(heic)).toBe("image/heic");
  });

  it("rejects SVG (text, scriptable)", () => {
    expect(sniffImageType(Buffer.from("<svg xmlns=..."))).toBeNull();
  });

  it("rejects arbitrary / executable content", () => {
    expect(sniffImageType(Buffer.from("#!/bin/sh\nrm -rf /"))).toBeNull();
    expect(sniffImageType(bytes(0x4d, 0x5a))).toBeNull(); // PE/EXE header
  });

  it("rejects empty buffers", () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(isSupportedImage(Buffer.alloc(0))).toBe(false);
  });
});
