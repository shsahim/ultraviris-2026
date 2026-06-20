import { describe, expect, it } from "vitest";
import {
  imageExistsWithFallback,
  resolveFileLocationWithFallback,
  resolveImageKey,
  toImageUrl,
} from "@/lib/image-resolve";

describe("toImageUrl", () => {
  it("builds a plain URL for simple keys", () => {
    expect(toImageUrl("https://cdn.example.com", "images/x/foo.jpg")).toBe(
      "https://cdn.example.com/images/x/foo.jpg"
    );
  });

  it("encodes spaces in a path segment", () => {
    expect(toImageUrl("https://cdn.example.com", "images/a b.jpg")).toBe(
      "https://cdn.example.com/images/a%20b.jpg"
    );
  });

  it("encodes reserved characters that would otherwise corrupt the URL", () => {
    expect(toImageUrl("https://cdn.example.com", "images/a#b?c.jpg")).toBe(
      "https://cdn.example.com/images/a%23b%3Fc.jpg"
    );
  });

  it("does not escape the slash separators", () => {
    expect(toImageUrl("https://cdn.example.com", "a/b/c.jpg")).toBe(
      "https://cdn.example.com/a/b/c.jpg"
    );
  });

  it("produces a valid URL parseable by the WHATWG URL parser", () => {
    const url = toImageUrl("https://cdn.example.com", "images/a #b.jpg");
    expect(() => new URL(url)).not.toThrow();
    expect(new URL(url).pathname).toBe("/images/a%20%23b.jpg");
  });

  it("builds a root-relative path when baseUrl is empty", () => {
    expect(toImageUrl("", "images/a b.jpg")).toBe("/images/a%20b.jpg");
  });
});

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

describe("resolveImageKey", () => {
  it("returns the exact key when present", () => {
    const keys = new Set(["images/x/foo.jpg"]);
    expect(resolveImageKey("images/x/foo.jpg", keys)).toBe("images/x/foo.jpg");
  });

  it("swaps a mismatched extension", () => {
    const keys = new Set(["images/x/foo.jpg"]);
    expect(resolveImageKey("images/x/foo.png", keys)).toBe("images/x/foo.jpg");
  });

  it("appends a missing extension when the stem matches", () => {
    const keys = new Set(["images/x/foo.jpg"]);
    expect(resolveImageKey("images/x/foo", keys)).toBe("images/x/foo.jpg");
  });

  it("matches a same-folder stem with a non-listed extension or case diff", () => {
    const keys = new Set(["images/x/FOO.JPG"]);
    expect(resolveImageKey("images/x/foo", keys)).toBe("images/x/FOO.JPG");
  });

  it("prefers canonical extensions when several siblings share a stem", () => {
    const keys = new Set([
      "images/x/foo.gif",
      "images/x/foo.jpg",
      "images/x/foo.webp",
    ]);
    expect(resolveImageKey("images/x/foo", keys)).toBe("images/x/foo.jpg");
  });

  it("does not match a different stem in the same folder", () => {
    const keys = new Set(["images/x/foobar.jpg"]);
    expect(resolveImageKey("images/x/foo.png", keys)).toBeNull();
  });

  it("does not match across folders", () => {
    const keys = new Set(["images/y/foo.jpg"]);
    expect(resolveImageKey("images/x/foo.png", keys)).toBeNull();
  });

  it("recovers a truncated filename via a unique prefix match", () => {
    const keys = new Set([
      "images/s/11178668_2050394151_n-1781816765133.jpg",
    ]);
    expect(
      resolveImageKey("images/s/11178668_2050394151_n-17818167", keys)
    ).toBe("images/s/11178668_2050394151_n-1781816765133.jpg");
  });

  it("does not prefix-match when multiple candidates are ambiguous", () => {
    const keys = new Set([
      "images/s/11178668_2050394151_n-1781816765133.jpg",
      "images/s/11178668_2050394151_n-1781816799999.jpg",
    ]);
    expect(
      resolveImageKey("images/s/11178668_2050394151_n-17818167", keys)
    ).toBeNull();
  });

  it("does not prefix-match on a trivially short stem", () => {
    const keys = new Set(["images/x/abcdef-123.jpg"]);
    expect(resolveImageKey("images/x/abc", keys)).toBeNull();
  });
});
