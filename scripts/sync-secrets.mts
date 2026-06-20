/**
 * Sync the local .env into the production "env" secret (AWS Secrets Manager),
 * safely. The merge is non-destructive and the result is validated before it is
 * written; `make ship` then deploys and rolls the secret back if the new
 * container fails its health check.
 *
 * Usage:
 *   tsx scripts/sync-secrets.mts                 # dry-run: validate + show diff
 *   tsx scripts/sync-secrets.mts --apply         # validate, then write the secret
 *   tsx scripts/sync-secrets.mts --rollback      # restore the previous version
 *
 * Env:
 *   ENV_SECRET   Secrets Manager secret id     (default: ultraviris/env)
 *   AWS_REGION   AWS region                     (default: us-west-2)
 *   ENV_FILE     local dotenv to read           (default: .env.local)
 *
 * Exit codes: 0 ok, 1 validation/runtime error, 2 bad usage.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diffEnv,
  mergeEnv,
  parseEnv,
  redact,
  serializeEnv,
  validateSecrets,
  type EnvMap,
} from "../lib/env-secrets";

const ENV_SECRET = process.env.ENV_SECRET ?? "ultraviris/env";
const AWS_REGION = process.env.AWS_REGION ?? "us-west-2";
const ENV_FILE = process.env.ENV_FILE ?? ".env.local";

function log(msg = ""): void {
  process.stderr.write(`${msg}\n`);
}

function aws(args: string[]): string {
  return execFileSync("aws", ["--region", AWS_REGION, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getSecretString(versionStage?: string): string | null {
  try {
    const args = [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      ENV_SECRET,
      "--query",
      "SecretString",
      "--output",
      "text",
    ];
    if (versionStage) args.push("--version-stage", versionStage);
    return aws(args);
  } catch {
    return null;
  }
}

function putSecretString(value: string): void {
  const dir = mkdtempSync(join(tmpdir(), "uvsecret-"));
  const file = join(dir, "secret");
  try {
    writeFileSync(file, value, { mode: 0o600 });
    aws([
      "secretsmanager",
      "put-secret-value",
      "--secret-id",
      ENV_SECRET,
      "--secret-string",
      `file://${file}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printDiff(current: EnvMap, next: EnvMap): void {
  const { added, changed, unchanged } = diffEnv(current, next);
  log(`Diff for secret "${ENV_SECRET}" (region ${AWS_REGION}):`);
  if (added.length === 0 && changed.length === 0) {
    log("  (no changes — secret already matches)");
  }
  for (const k of added) log(`  + ${k} = ${redact(k, next.get(k) ?? "")}`);
  for (const k of changed) {
    log(
      `  ~ ${k} = ${redact(k, current.get(k) ?? "")} -> ${redact(k, next.get(k) ?? "")}`
    );
  }
  log(`  (${unchanged.length} unchanged, ${next.size} total keys)`);
}

function printValidation(map: EnvMap): boolean {
  const { errors, warnings } = validateSecrets(map);
  for (const w of warnings) log(`  warning: ${w}`);
  for (const e of errors) log(`  ERROR:   ${e}`);
  return errors.length === 0;
}

function rollback(): never {
  const previous = getSecretString("AWSPREVIOUS");
  if (previous === null) {
    log(`No previous version of "${ENV_SECRET}" to roll back to — leaving as-is.`);
    process.exit(0);
  }
  putSecretString(previous);
  log(`Rolled "${ENV_SECRET}" back to its previous version.`);
  process.exit(0);
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  if (args.has("--rollback")) rollback();

  const apply = args.has("--apply");

  const currentRaw = getSecretString();
  if (currentRaw === null) {
    log(
      `Could not read secret "${ENV_SECRET}". Does it exist and are AWS creds set?`
    );
    process.exit(1);
  }

  let localRaw: string;
  try {
    localRaw = readFileSync(ENV_FILE, "utf8");
  } catch {
    log(`Could not read ${ENV_FILE}.`);
    process.exit(1);
  }

  const current = parseEnv(currentRaw);
  const local = parseEnv(localRaw);
  const next = mergeEnv(current, local);

  printDiff(current, next);
  log("");
  log("Validation:");
  const ok = printValidation(next);

  if (!ok) {
    log("");
    log("Refusing to update the secret — fix the errors above first.");
    process.exit(1);
  }

  if (!apply) {
    log("");
    log("Dry run (pass --apply to write). No changes made.");
    process.exit(0);
  }

  putSecretString(serializeEnv(next));
  log("");
  log(`Updated secret "${ENV_SECRET}". Previous version retained for rollback.`);
  process.exit(0);
}

main();
