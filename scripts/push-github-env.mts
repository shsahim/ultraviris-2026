/**
 * Push the local .env into the repo's GitHub Actions config so CI can rebuild the
 * production env and sync it to Secrets Manager (mirroring `make ship`).
 *
 * Each key is classified (see lib/env-secrets.classifyEnvKey):
 *   - sensitive / infra identifiers -> GitHub *secret*  APP_<KEY>
 *   - other config                  -> GitHub *variable* APP_<KEY>
 *   - local-only keys (paths, static AWS creds)         -> skipped
 *
 * The APP_ prefix is required because GitHub reserves the GITHUB_ prefix and so
 * that CI can tell app config apart from workflow secrets (AWS_ROLE_ARN, etc.).
 * Empty values are skipped so CI's non-destructive merge keeps prod's value.
 *
 * Usage:
 *   tsx scripts/push-github-env.mts            # push from .env.local
 *   tsx scripts/push-github-env.mts --dry-run  # show what would be pushed
 *
 * Env: ENV_FILE (default .env.local). Requires an authenticated gh CLI.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { classifyEnvKey, parseEnv, redact } from "../lib/env-secrets";

const ENV_FILE = process.env.ENV_FILE ?? ".env.local";
const PREFIX = "APP_";
const dryRun = process.argv.includes("--dry-run");

function log(msg = ""): void {
  process.stderr.write(`${msg}\n`);
}

function requireGh(): void {
  if (dryRun) return;
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
  } catch {
    log("GitHub CLI (gh) is required and must be authenticated: gh auth login");
    process.exit(1);
  }
}

function ghSet(kind: "secret" | "variable", name: string, value: string): void {
  execFileSync("gh", [kind, "set", name], { input: value, stdio: ["pipe", "ignore", "inherit"] });
}

function main(): void {
  let raw: string;
  try {
    raw = readFileSync(ENV_FILE, "utf8");
  } catch {
    log(`Could not read ${ENV_FILE}.`);
    process.exit(1);
  }

  requireGh();

  const env = parseEnv(raw);
  let secrets = 0;
  let variables = 0;
  let skipped = 0;

  for (const [key, value] of env) {
    const kind = classifyEnvKey(key);
    if (kind === "skip") {
      skipped++;
      continue;
    }
    if (value.trim() === "") {
      log(`  skip ${key} (empty — prod keeps its current value)`);
      skipped++;
      continue;
    }

    const name = `${PREFIX}${key}`;
    if (dryRun) {
      log(`  would set ${kind} ${name} = ${redact(key, value)}`);
    } else {
      ghSet(kind, name, value);
      log(`  + ${kind} ${name}`);
    }
    if (kind === "secret") secrets++;
    else variables++;
  }

  log("");
  log(
    `${dryRun ? "Would push" : "Pushed"} ${secrets} secret(s) + ${variables} variable(s); ${skipped} skipped.`
  );
}

main();
