import { afterEach, describe, expect, it } from "vitest";
import { resolveImageSrc } from "@/lib/images";

const ORIGINAL_BASE = process.env.IMAGE_BASE_URL;

afterEach(() => {
  if (ORIGINAL_BASE === undefined) {
    delete process.env.IMAGE_BASE_URL;
  } else {
    process.env.IMAGE_BASE_URL = ORIGINAL_BASE;
  }
});

describe("resolveImageSrc (local mode)", () => {
  it("prefixes a bare relative path with a leading slash", () => {
    delete process.env.IMAGE_BASE_URL;
    expect(resolveImageSrc("images/brain_juice/a.jpg")).toBe(
      "/images/brain_juice/a.jpg"
    );
  });

  it("normalizes a leading ./ or / and trims whitespace", () => {
    delete process.env.IMAGE_BASE_URL;
    expect(resolveImageSrc("  ./images/x.png ")).toBe("/images/x.png");
    expect(resolveImageSrc("/images/x.png")).toBe("/images/x.png");
  });

  it("returns empty string input as a root slash", () => {
    delete process.env.IMAGE_BASE_URL;
    expect(resolveImageSrc("")).toBe("/");
  });
});

describe("resolveImageSrc (absolute URLs)", () => {
  it("passes through http(s) URLs unchanged", () => {
    expect(resolveImageSrc("https://cdn.example.com/x.jpg")).toBe(
      "https://cdn.example.com/x.jpg"
    );
    expect(resolveImageSrc("http://cdn.example.com/x.jpg")).toBe(
      "http://cdn.example.com/x.jpg"
    );
  });
});

describe("resolveImageSrc (S3/CDN base)", () => {
  it("joins IMAGE_BASE_URL with the relative path, trimming slashes", () => {
    process.env.IMAGE_BASE_URL = "https://bucket.s3.amazonaws.com/";
    expect(resolveImageSrc("images/x.jpg")).toBe(
      "https://bucket.s3.amazonaws.com/images/x.jpg"
    );
  });
});
