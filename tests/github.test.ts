import { describe, expect, it, vi } from "vitest";

// Avoid pulling in real network/server dependencies during import.
vi.mock("@/lib/db", () => ({ query: vi.fn() }));

import { hasCheckedTaskBox } from "@/lib/github";

describe("hasCheckedTaskBox", () => {
  it("detects a lowercase checked box", () => {
    expect(hasCheckedTaskBox("- [x] done")).toBe(true);
  });

  it("detects an uppercase checked box", () => {
    expect(hasCheckedTaskBox("- [X] done")).toBe(true);
  });

  it("detects an asterisk bullet checked box", () => {
    expect(hasCheckedTaskBox("* [x] done")).toBe(true);
  });

  it("detects an indented checked box", () => {
    expect(hasCheckedTaskBox("    - [x] nested done")).toBe(true);
  });

  it("detects a checked box on a later line", () => {
    const body = "Some intro text\n\n- [ ] todo\n- [x] finished";
    expect(hasCheckedTaskBox(body)).toBe(true);
  });

  it("returns false for only unchecked boxes", () => {
    expect(hasCheckedTaskBox("- [ ] not done\n- [ ] also not done")).toBe(false);
  });

  it("returns false when there are no task boxes", () => {
    expect(hasCheckedTaskBox("Just a plain description.")).toBe(false);
  });

  it("returns false for empty or null bodies", () => {
    expect(hasCheckedTaskBox("")).toBe(false);
    expect(hasCheckedTaskBox(null)).toBe(false);
  });

  it("does not match [x] without a list marker", () => {
    expect(hasCheckedTaskBox("inline [x] text")).toBe(false);
  });
});
