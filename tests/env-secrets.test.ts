import { describe, expect, it } from "vitest";

import {
  diffEnv,
  mergeEnv,
  parseEnv,
  redact,
  serializeEnv,
  validateSecrets,
  MIN_SESSION_SECRET_LENGTH,
  type EnvMap,
} from "@/lib/env-secrets";

// A baseline of values that pass validation, so each test can tweak one thing.
function validBase(): EnvMap {
  return new Map<string, string>([
    ["MYSQL_HOST", "uvdb1.abc123.us-west-2.rds.amazonaws.com"],
    ["MYSQL_PORT", "3306"],
    ["MYSQL_USER", "app"],
    ["MYSQL_PASSWORD", "s3cr3t"],
    ["MYSQL_DATABASE", "ultraviris"],
    ["ADMIN_SESSION_SECRET", "x".repeat(MIN_SESSION_SECRET_LENGTH)],
    ["HEALTH_CHECK_SECRET", "health-token-long"],
    ["S3_BUCKET", "ultraviris-images"],
    ["IMAGE_BASE_URL", "https://cdn.example.com"],
    ["SES_FROM_EMAIL", "noreply@example.com"],
    ["CONTACT_TO_EMAIL", "hi@example.com"],
    ["SSH_HOST", "bastion.example.com"],
    ["SSH_USER", "ec2-user"],
    ["GITHUB_TOKEN", "ghp_xxx"],
    ["GITHUB_ISSUE_REPO", "shsahim/ultraviris-2026"],
  ]);
}

describe("parseEnv / serializeEnv", () => {
  it("parses KEY=VALUE, skips comments/blanks, strips matching quotes", () => {
    const m = parseEnv(
      ['# comment', '', 'A=1', 'B="two words"', "C='x'", "BAD LINE", "=nope"].join(
        "\n"
      )
    );
    expect(m.get("A")).toBe("1");
    expect(m.get("B")).toBe("two words");
    expect(m.get("C")).toBe("x");
    expect(m.has("BAD")).toBe(false);
    expect(m.size).toBe(3);
  });

  it("keeps '=' inside values (splits on first =)", () => {
    expect(parseEnv("URL=https://x/y?a=b").get("URL")).toBe("https://x/y?a=b");
  });

  it("serializes without quotes (docker --env-file is quote-literal)", () => {
    const out = serializeEnv(new Map([["B", "two words"]]));
    expect(out).toBe("B=two words\n");
  });

  it("round-trips", () => {
    const m = parseEnv("A=1\nB=2\n");
    expect(parseEnv(serializeEnv(m))).toEqual(m);
  });
});

describe("mergeEnv (non-destructive)", () => {
  it("overlays local values and never drops existing secret keys", () => {
    const current = new Map([
      ["KEEP", "prod"],
      ["OVERRIDE", "old"],
    ]);
    const local = new Map([
      ["OVERRIDE", "new"],
      ["NEW", "added"],
    ]);
    const merged = mergeEnv(current, local);
    expect(merged.get("KEEP")).toBe("prod"); // prod-only key preserved
    expect(merged.get("OVERRIDE")).toBe("new"); // local wins
    expect(merged.get("NEW")).toBe("added");
  });

  it("does NOT blank a non-empty prod value with an empty local value", () => {
    const current = new Map([["IMAGE_BASE_URL", "https://cdn.example.com"]]);
    const local = new Map([
      ["IMAGE_BASE_URL", ""], // empty locally (serving from public/)
      ["NEW_EMPTY", ""], // absent in prod — empty is fine to add
    ]);
    const merged = mergeEnv(current, local);
    expect(merged.get("IMAGE_BASE_URL")).toBe("https://cdn.example.com");
    expect(merged.get("NEW_EMPTY")).toBe("");
  });
});

describe("diffEnv", () => {
  it("classifies added / changed / unchanged", () => {
    const current = new Map([
      ["A", "1"],
      ["B", "2"],
    ]);
    const next = new Map([
      ["A", "1"],
      ["B", "changed"],
      ["C", "new"],
    ]);
    const d = diffEnv(current, next);
    expect(d.added).toEqual(["C"]);
    expect(d.changed).toEqual(["B"]);
    expect(d.unchanged).toEqual(["A"]);
  });
});

describe("redact", () => {
  it("masks sensitive values, shows non-sensitive verbatim", () => {
    expect(redact("MYSQL_PASSWORD", "hunter2")).toMatch(/^••••\(7\)$/);
    expect(redact("ADMIN_SESSION_SECRET", "x".repeat(40))).toMatch(/\(40\)$/);
    expect(redact("GITHUB_TOKEN", "abc")).toMatch(/\(3\)$/);
    expect(redact("MYSQL_HOST", "rds.example.com")).toBe("rds.example.com");
    expect(redact("S3_BUCKET", "")).toBe("(empty)");
  });
});

describe("validateSecrets — passes a complete, sane config", () => {
  it("has no errors", () => {
    const { errors } = validateSecrets(validBase());
    expect(errors).toEqual([]);
  });
});

describe("validateSecrets — blocks deployment-breaking configs", () => {
  it("errors when a required key is missing", () => {
    const m = validBase();
    m.delete("MYSQL_PASSWORD");
    const { errors } = validateSecrets(m);
    expect(errors).toContain("Missing required key: MYSQL_PASSWORD");
  });

  it("errors when a required key is present but empty", () => {
    const m = validBase();
    m.set("MYSQL_DATABASE", "   ");
    const { errors } = validateSecrets(m);
    expect(errors).toContain("Missing required key: MYSQL_DATABASE");
  });

  it("errors on a too-short ADMIN_SESSION_SECRET", () => {
    const m = validBase();
    m.set("ADMIN_SESSION_SECRET", "short");
    const { errors } = validateSecrets(m);
    expect(errors.some((e) => e.includes("ADMIN_SESSION_SECRET is too short"))).toBe(
      true
    );
  });

  it("errors when prod hosts/URLs point to localhost", () => {
    for (const [k, v] of [
      ["MYSQL_HOST", "127.0.0.1"],
      ["SSH_HOST", "localhost"],
      ["IMAGE_BASE_URL", "http://localhost:3000"],
    ] as const) {
      const m = validBase();
      m.set(k, v);
      const { errors } = validateSecrets(m);
      expect(errors.some((e) => e.startsWith(`${k} points to localhost`))).toBe(true);
    }
  });

  it("errors on non-numeric numeric fields", () => {
    const m = validBase();
    m.set("MYSQL_PORT", "abc");
    const { errors } = validateSecrets(m);
    expect(errors.some((e) => e.startsWith("MYSQL_PORT must be"))).toBe(true);
  });

  it("errors on a malformed GITHUB_ISSUE_REPO", () => {
    const m = validBase();
    m.set("GITHUB_ISSUE_REPO", "not-a-repo");
    const { errors } = validateSecrets(m);
    expect(errors.some((e) => e.includes('GITHUB_ISSUE_REPO must be "owner/repo"'))).toBe(
      true
    );
  });
});

describe("validateSecrets — advisory warnings (do not block)", () => {
  it("warns when recommended keys are missing", () => {
    const m = validBase();
    m.delete("S3_BUCKET");
    const { errors, warnings } = validateSecrets(m);
    expect(errors).toEqual([]);
    expect(warnings).toContain("Recommended key not set: S3_BUCKET");
  });

  it("warns when static AWS credentials are present", () => {
    const m = validBase();
    m.set("AWS_ACCESS_KEY_ID", "AKIA...");
    const { warnings } = validateSecrets(m);
    expect(warnings.some((w) => w.startsWith("AWS_ACCESS_KEY_ID is set"))).toBe(true);
  });
});
