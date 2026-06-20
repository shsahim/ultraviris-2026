// Pure helpers for syncing the local .env into the production "env" secret.
//
// Deliberately framework-free (no `server-only`, no AWS SDK) so it can be unit
// tested and reused by scripts/sync-secrets.mts. The merge is NON-DESTRUCTIVE
// (the current secret is the base; local values are overlaid; nothing is
// dropped), and validateSecrets() encodes the rules that must hold for the
// deployment not to break.

export type EnvMap = Map<string, string>;

// Keys whose absence (or emptiness) will break the production container outright.
// These have no runtime override in deploy.sh, so they must always be present.
export const REQUIRED_KEYS = [
  "MYSQL_HOST",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_DATABASE",
  "ADMIN_SESSION_SECRET",
] as const;

// Keys that are strongly expected in production; missing ones degrade features
// (images, email, health-cron, DB tunnel, issue reporter) but don't hard-crash,
// so they're warnings rather than errors.
export const RECOMMENDED_KEYS = [
  "HEALTH_CHECK_SECRET",
  "S3_BUCKET",
  "IMAGE_BASE_URL",
  "SES_FROM_EMAIL",
  "CONTACT_TO_EMAIL",
  "SSH_HOST",
  "SSH_USER",
  "GITHUB_TOKEN",
] as const;

// Must parse as a non-negative integer when present.
export const NUMERIC_KEYS = [
  "MYSQL_PORT",
  "SSH_PORT",
  "MYSQL_CONNECTION_LIMIT",
  "ALERT_RESEND_MINUTES",
] as const;

// Must never resolve to a loopback address in production.
export const NO_LOCALHOST_KEYS = ["MYSQL_HOST", "SSH_HOST", "IMAGE_BASE_URL"] as const;

// Static AWS credentials should not live in the prod secret — the EC2 instance
// role provides them. Their presence is a warning (they override the role).
export const STATIC_AWS_CRED_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

export const MIN_SESSION_SECRET_LENGTH = 32;

// Keys that must never be pushed to GitHub or assembled from CI: local-only file
// paths and static AWS credentials (production uses the instance IAM role).
export const SKIP_PUSH_KEYS = [
  "SSH_PRIVATE_KEY_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "NODE_ENV",
] as const;

// Connection identifiers that reveal infrastructure — stored as GitHub *secrets*
// rather than plaintext *variables* even though they aren't passwords/tokens.
export const INFRA_SECRET_KEYS = [
  "MYSQL_HOST",
  "MYSQL_USER",
  "MYSQL_DATABASE",
  "SSH_HOST",
  "SSH_USER",
] as const;

export type EnvKeyClass = "secret" | "variable" | "skip";

/**
 * Classifies an env key for the curated GitHub Secrets/Variables sync used by CI.
 * Sensitive values (and infra identifiers) become repo *secrets*; everything else
 * becomes a plaintext *variable*; local-only keys are skipped. Callers store the
 * results under an APP_ prefix because GitHub reserves the GITHUB_ prefix.
 */
export function classifyEnvKey(key: string): EnvKeyClass {
  if ((SKIP_PUSH_KEYS as readonly string[]).includes(key)) return "skip";
  if (isSensitiveKey(key) || (INFRA_SECRET_KEYS as readonly string[]).includes(key)) {
    return "secret";
  }
  return "variable";
}

const LOCALHOST_RE = /(localhost|127\.0\.0\.1|::1)/i;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SENSITIVE_RE = /(TOKEN|SECRET|PASSWORD|PASSPHRASE|_KEY$|_KEY_|AWS_SECRET)/i;

/** Parses dotenv text into an ordered key→value map (comments/blanks skipped). */
export function parseEnv(text: string): EnvMap {
  const map: EnvMap = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

/**
 * Serializes a map to dotenv text WITHOUT quoting. Docker `--env-file` (used by
 * deploy.sh) treats quotes literally, so values must be written verbatim.
 */
export function serializeEnv(map: EnvMap): string {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
    .concat("\n");
}

/**
 * Non-destructive merge: start from the current secret and overlay local values.
 * No existing secret key is ever removed, and an EMPTY local value will not blank
 * out a non-empty production value (local dev frequently leaves keys empty — e.g.
 * IMAGE_BASE_URL or AWS creds when relying on a mounted profile). A local value
 * only wins when it is non-empty, or when the key is absent/empty in production.
 */
export function mergeEnv(current: EnvMap, local: EnvMap): EnvMap {
  const out: EnvMap = new Map(current);
  for (const [k, v] of local) {
    const localEmpty = v.trim() === "";
    const currentNonEmpty = (out.get(k) ?? "").trim() !== "";
    if (localEmpty && currentNonEmpty) continue; // never blank an existing prod value
    out.set(k, v);
  }
  return out;
}

export interface EnvDiff {
  added: string[];
  changed: string[];
  unchanged: string[];
}

/** Keys added or changed going from `current` to `next` (next is a superset). */
export function diffEnv(current: EnvMap, next: EnvMap): EnvDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [k, v] of next) {
    if (!current.has(k)) added.push(k);
    else if (current.get(k) !== v) changed.push(k);
    else unchanged.push(k);
  }
  return { added, changed, unchanged };
}

/** True for keys whose values must be masked when displayed. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_RE.test(key);
}

/** Masks a value for human-readable diffs/logs. */
export function redact(key: string, value: string): string {
  if (!value) return "(empty)";
  if (isSensitiveKey(key)) return `••••(${value.length})`;
  return value;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Validates the *resulting* secret map (post-merge). Errors mean "do not deploy
 * this — it will break"; warnings are advisory. This is the contract exercised
 * by the unit tests.
 */
export function validateSecrets(map: EnvMap): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const get = (k: string) => (map.get(k) ?? "").trim();

  for (const key of REQUIRED_KEYS) {
    if (!get(key)) errors.push(`Missing required key: ${key}`);
  }

  const session = get("ADMIN_SESSION_SECRET");
  if (session && session.length < MIN_SESSION_SECRET_LENGTH) {
    errors.push(
      `ADMIN_SESSION_SECRET is too short (${session.length} chars; need >= ${MIN_SESSION_SECRET_LENGTH}).`
    );
  }

  for (const key of NO_LOCALHOST_KEYS) {
    const v = get(key);
    if (v && LOCALHOST_RE.test(v)) {
      errors.push(`${key} points to localhost ("${v}") — invalid in production.`);
    }
  }

  for (const key of NUMERIC_KEYS) {
    const v = get(key);
    if (v && !/^\d+$/.test(v)) {
      errors.push(`${key} must be a non-negative integer (got "${v}").`);
    }
  }

  const repo = get("GITHUB_ISSUE_REPO");
  if (repo && !REPO_RE.test(repo)) {
    errors.push(`GITHUB_ISSUE_REPO must be "owner/repo" (got "${repo}").`);
  }

  for (const key of RECOMMENDED_KEYS) {
    if (!get(key)) warnings.push(`Recommended key not set: ${key}`);
  }

  for (const key of STATIC_AWS_CRED_KEYS) {
    if (get(key)) {
      warnings.push(
        `${key} is set — production normally uses the instance IAM role; static creds will override it.`
      );
    }
  }

  return { errors, warnings };
}
