import { describe, expect, it, vi } from "vitest";

// Avoid loading the real DB module (and its native ssh2/mysql2 deps).
vi.mock("@/lib/db", () => ({ query: vi.fn() }));

import { escapeId, slugifyTableName, toFriendlyName } from "@/lib/admin-db";

describe("escapeId", () => {
  it("wraps identifiers in backticks", () => {
    expect(escapeId("brain_juice")).toBe("`brain_juice`");
  });

  it("escapes embedded backticks (SQL injection defense)", () => {
    expect(escapeId("a`b")).toBe("`a``b`");
  });
});

describe("slugifyTableName", () => {
  it("lowercases and replaces non-alphanumerics with underscores", () => {
    expect(slugifyTableName("Sculptures & Installations!")).toBe(
      "sculptures_installations"
    );
  });

  it("trims leading/trailing underscores", () => {
    expect(slugifyTableName("  Psycho Decay  ")).toBe("psycho_decay");
  });

  it("prefixes names that start with a digit", () => {
    expect(slugifyTableName("2024 works")).toBe("t_2024_works");
  });

  it("falls back to 'project' for empty/symbol-only input", () => {
    expect(slugifyTableName("***")).toBe("project");
    expect(slugifyTableName("")).toBe("project");
  });

  it("caps length at 63 characters", () => {
    expect(slugifyTableName("a".repeat(100)).length).toBe(63);
  });
});

describe("toFriendlyName", () => {
  it("title-cases an underscored table name", () => {
    expect(toFriendlyName("brain_juice")).toBe("Brain Juice");
    expect(toFriendlyName("sculptures_and_installations")).toBe(
      "Sculptures And Installations"
    );
  });

  it("collapses repeated separators and whitespace", () => {
    expect(toFriendlyName("psycho--decay")).toBe("Psycho Decay");
  });
});
