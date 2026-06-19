import { describe, expect, it } from "vitest";
import {
  imageExistsWithFallback,
  resolveFileLocationWithFallback,
} from "@/lib/image-resolve";

describe("resolveFileLocationWithFallback", () => {
  it("returns the original path when it exists", () => {
    const exists = (p: string) => p === "images/foo.png";
    expect(resolveFileLocationWithFallback("images/foo.png", exists)).toBe(
      "images/foo.png"
    );
  });

  it("falls back to a sibling extension when the stored ext is missing", () => {
    const keys = new Set(["images/gallery/photo.jpg"]);
    const exists = (p: string) => keys.has(p);
    expect(
      resolveFileLocationWithFallback("images/gallery/photo.png", exists)
    ).toBe("images/gallery/photo.jpg");
  });

  it("tries multiple fallbacks in order", () => {
    const keys = new Set(["images/x.webp"]);
    const exists = (p: string) => keys.has(p);
    expect(resolveFileLocationWithFallback("images/x.png", exists)).toBe(
      "images/x.webp"
    );
  });

  it("returns the original path when no sibling exists", () => {
    const exists = () => false;
    expect(resolveFileLocationWithFallback("images/missing.png", exists)).toBe(
      "images/missing.png"
    );
  });
});

describe("imageExistsWithFallback", () => {
  it("is true for an exact match", () => {
    expect(imageExistsWithFallback("images/a.jpg", (p) => p === "images/a.jpg")).toBe(
      true
    );
  });

  it("is true when only a sibling extension exists", () => {
    const keys = new Set(["images/a.jpeg"]);
    expect(imageExistsWithFallback("/images/a.png", (p) => keys.has(p))).toBe(true);
  });

  it("is false for empty paths", () => {
    expect(imageExistsWithFallback("", () => true)).toBe(false);
  });
});
