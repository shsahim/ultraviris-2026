import { afterEach, describe, expect, it, vi } from "vitest";

// Avoid loading the real DB module (and its native ssh2/mysql2 deps).
// `vi.hoisted` lets the mock factory (which is hoisted) reference this fn.
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ query }));

// resolve-image pulls in the AWS SDK; stub it since these tests don't need it.
vi.mock("@/lib/resolve-image", () => ({
  resolveImage: vi.fn(async (loc: string) => loc),
  getImageBaseUrl: vi.fn(() => ""),
  buildAdminImageSrcMap: vi.fn(async () => ({})),
}));

import { getActiveProjects } from "@/lib/data";
import { invalidateAll } from "@/lib/cache";

afterEach(() => {
  query.mockReset();
  invalidateAll();
});

describe("getActiveProjects error handling", () => {
  it("returns [] when the load fails", async () => {
    query.mockRejectedValueOnce(new Error("DB unreachable"));
    await expect(getActiveProjects()).resolves.toEqual([]);
  });

  it("does NOT cache a failed load (a transient blip is retried next call)", async () => {
    const rows = [{ id: 1, name: "Brain Juice", table_name: "brain_juice" }];

    // First call fails (e.g. SSH tunnel hiccup) and must not be cached.
    query.mockRejectedValueOnce(new Error("DB unreachable"));
    await expect(getActiveProjects()).resolves.toEqual([]);

    // Next call succeeds because the empty/error result was never stored.
    query.mockResolvedValueOnce(rows);
    await expect(getActiveProjects()).resolves.toEqual(rows);

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("caches a successful load (second call does not re-query)", async () => {
    const rows = [{ id: 1, name: "Brain Juice", table_name: "brain_juice" }];
    query.mockResolvedValueOnce(rows);

    await expect(getActiveProjects()).resolves.toEqual(rows);
    await expect(getActiveProjects()).resolves.toEqual(rows);

    expect(query).toHaveBeenCalledTimes(1);
  });
});
