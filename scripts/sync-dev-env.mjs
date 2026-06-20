#!/usr/bin/env node
/**
 * Export / import local dev secrets so you can move between machines.
 *
 * Local bundle (export / import):
 *   - .env.local, scripts/aws-setup.config, scripts/aws-setup-outputs.env
 *   - SSH private key, optional AWS CLI + GitHub CLI token
 *
 * GitHub secrets (push-gh / pull-gh):
 *   - push-gh uploads passwords, API keys, and private keys as repo secrets
 *   - pull-gh triggers export-dev-secrets.yml, downloads a 1-day artifact, imports
 *   - GitHub does not allow reading secret values via API; the workflow bridges that gap
 *
 * Usage (from repo root):
 *   node scripts/sync-dev-env.mjs push-gh --include-aws
 *   node scripts/sync-dev-env.mjs pull-gh --include-aws
 *   node scripts/sync-dev-env.mjs export --include-aws
 *   node scripts/sync-dev-env.mjs import ./ultraviris-dev-bundle.tar.gz
 *
 * Requires gh (https://cli.github.com/) for push-gh / pull-gh.
 * Local archives are NOT encrypted — store and transfer them securely.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_VERSION = 1;

const PROJECT_FILES = [
  ".env.local",
  "scripts/aws-setup.config",
  "scripts/aws-setup-outputs.env",
];

const GH_WORKFLOW = "export-dev-secrets.yml";
const GH_ARTIFACT = "dev-secrets-bundle";

/** Env keys that are paths, not secret values. */
const SENSITIVE_ENV_EXCLUDE = new Set([
  "SSH_PRIVATE_KEY_PATH",
  "MYSQL_CONNECTION_LIMIT",
  "SSH_PORT",
  "MYSQL_PORT",
  "ALERT_RESEND_MINUTES",
]);

/** Match passwords, API keys, private-key passphrases, tokens, etc. */
const SENSITIVE_ENV_PATTERN = /(PASSWORD|SECRET|KEY|TOKEN|CREDENTIAL)/i;

/** Whole-file blobs stored for pull-gh workflow round-trip. */
const GH_BLOB_SECRETS = [
  { name: "DEV_ENV_LOCAL", rel: ".env.local", required: true },
  { name: "DEV_SSH_PRIVATE_KEY", kind: "ssh" },
  { name: "DEV_AWS_SETUP_CONFIG", rel: "scripts/aws-setup.config" },
  { name: "DEV_AWS_SETUP_OUTPUTS", rel: "scripts/aws-setup-outputs.env" },
  { name: "DEV_AWS_CREDENTIALS", kind: "aws-credentials" },
  { name: "DEV_AWS_CONFIG", kind: "aws-config" },
];

function usage() {
  console.log(`Usage:
  node scripts/sync-dev-env.mjs push-gh [options]
  node scripts/sync-dev-env.mjs pull-gh [options]
  node scripts/sync-dev-env.mjs export [options]
  node scripts/sync-dev-env.mjs import <bundle> [options]

GitHub secrets (requires gh auth login):
  push-gh              Upload passwords, API keys, and private keys to repo secrets
  pull-gh              Download via workflow artifact and restore locally

push-gh options:
  --include-aws        Also store ~/.aws/credentials and config
  --no-aws             Skip AWS CLI files
  --dry-run            Show what would be uploaded

pull-gh options:
  --include-aws        Restore AWS CLI credentials from the bundle
  --ssh-dest <path>    Where to install SSH key (default: ~/.ssh/ultraviris-db-key)
  --aws-merge          Merge AWS profiles instead of overwriting
  --dry-run            Preview import after download
  --force              Overwrite existing local files

Local export options:
  --out <path>         Output .tar.gz or directory
  --include-aws        Include AWS CLI credentials
  --include-gh         Include GitHub CLI token
  --profile <name>     AWS profile to export
  --no-aws             Skip AWS credentials

Local import options:
  --ssh-dest <path>    SSH key destination
  --include-aws        Restore AWS CLI credentials
  --aws-merge          Merge AWS profiles
  --dry-run            Preview only
  --force              Overwrite existing files

Examples:
  node scripts/sync-dev-env.mjs push-gh --include-aws
  node scripts/sync-dev-env.mjs pull-gh --include-aws
  node scripts/sync-dev-env.mjs export --include-aws
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  const options = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (
        ["out", "profile", "ssh-dest"].includes(key) &&
        next &&
        !next.startsWith("--")
      ) {
        options[key] = next;
        i++;
      } else {
        flags.add(key);
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, flags, options };
}

function expandHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) {
    return path.join(homedir(), filePath.slice(2));
  }
  return filePath;
}

function readDotenv(filePath) {
  const values = {};
  if (!existsSync(filePath)) return values;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[m[1]] = value;
  }
  return values;
}

function readShellExports(filePath) {
  const values = {};
  if (!existsSync(filePath)) return values;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^export\s+([A-Z0-9_]+)=["']?(.*?)["']?$/);
    if (!m) continue;
    values[m[1]] = m[2];
  }
  return values;
}

function resolveSshKeyPath() {
  const envLocal = path.join(REPO_ROOT, ".env.local");
  const awsConfig = path.join(REPO_ROOT, "scripts/aws-setup.config");

  const fromEnv = readDotenv(envLocal).SSH_PRIVATE_KEY_PATH;
  if (fromEnv) {
    const resolved = expandHome(fromEnv);
    if (existsSync(resolved)) return resolved;
  }

  const fromAwsSetup = readShellExports(awsConfig).SSH_KEY_FILE;
  if (fromAwsSetup) {
    const resolved = expandHome(fromAwsSetup);
    if (existsSync(resolved)) return resolved;
  }

  return null;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function secureCopy(src, dest, dryRun) {
  if (dryRun) {
    console.log(`  would copy ${src} -> ${dest}`);
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  chmodSync(dest, 0o600);
}

function writeSecureFile(dest, content, dryRun) {
  if (dryRun) {
    console.log(`  would write ${dest}`);
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content, { mode: 0o600 });
}

function runTarCreate(archivePath, sourceDir) {
  const result = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", path.dirname(sourceDir), path.basename(sourceDir)],
    { stdio: "inherit" }
  );
  return result.status === 0;
}

function runTarExtract(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], {
    stdio: "inherit",
  });
  return result.status === 0;
}

function findBundleRoot(dir) {
  if (existsSync(path.join(dir, "manifest.json"))) return dir;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dir, entry.name);
    if (existsSync(path.join(candidate, "manifest.json"))) {
      return candidate;
    }
  }
  return null;
}

function collectExportItems({ includeAws, includeGh, profile, noAws }) {
  const items = [];
  const warnings = [];
  const manifest = {
    version: MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    platform: platform(),
    repo: "ultraviris-2026",
    files: {},
    ssh: null,
    aws: null,
    gh: null,
  };

  for (const rel of PROJECT_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    if (existsSync(abs)) {
      items.push({ kind: "project", rel, abs });
      manifest.files[rel] = { included: true };
    } else {
      manifest.files[rel] = { included: false, reason: "not found" };
      warnings.push(`Skipping missing project file: ${rel}`);
    }
  }

  const sshSource = resolveSshKeyPath();
  if (sshSource) {
    items.push({
      kind: "ssh",
      rel: "ssh/private-key",
      abs: sshSource,
    });
    manifest.ssh = {
      bundlePath: "ssh/private-key",
      originalPath: sshSource,
    };
  } else {
    warnings.push(
      "No SSH private key found (set SSH_PRIVATE_KEY_PATH in .env.local or SSH_KEY_FILE in scripts/aws-setup.config)"
    );
  }

  const awsProfile = profile || process.env.AWS_PROFILE || "default";
  if (includeAws && !noAws) {
    const awsDir = path.join(homedir(), ".aws");
    const credPath = path.join(awsDir, "credentials");
    const configPath = path.join(awsDir, "config");
    let credIncluded = false;
    let configIncluded = false;

    if (existsSync(credPath)) {
      items.push({ kind: "aws", rel: "aws/credentials", abs: credPath });
      credIncluded = true;
    }
    if (existsSync(configPath)) {
      items.push({ kind: "aws", rel: "aws/config", abs: configPath });
      configIncluded = true;
    }

    manifest.aws = {
      profile: awsProfile,
      credentials: credIncluded,
      config: configIncluded,
    };

    if (!credIncluded && !configIncluded) {
      warnings.push("AWS CLI files not found in ~/.aws/");
    }
  }

  if (includeGh) {
    const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
    if (gh.status === 0 && gh.stdout.trim()) {
      manifest.gh = { included: true, note: "Restore with: gh auth login --with-token" };
      items.push({
        kind: "gh",
        rel: "gh/token",
        content: gh.stdout.trim() + "\n",
      });
    } else {
      manifest.gh = { included: false, reason: gh.stderr?.trim() || "gh not available" };
      warnings.push("Could not read GitHub token (install gh and run: gh auth login)");
    }
  }

  return { items, manifest, warnings };
}

function exportBundle({ flags, options }) {
  const includeAws = flags.has("include-aws");
  const includeGh = flags.has("include-gh");
  const noAws = flags.has("no-aws");
  const profile = options.profile;

  const defaultOut = path.join(
    REPO_ROOT,
    `ultraviris-dev-bundle-${timestamp()}.tar.gz`
  );
  const out = options.out ? path.resolve(options.out) : defaultOut;

  const stagingParent = mkdtempSync(path.join(REPO_ROOT, ".dev-bundle-staging-"));
  const bundleDir = path.join(stagingParent, "ultraviris-dev-bundle");

  try {
    const { items, manifest, warnings } = collectExportItems({
      includeAws,
      includeGh,
      profile,
      noAws,
    });

    mkdirSync(bundleDir, { recursive: true });

    for (const item of items) {
      const dest = path.join(bundleDir, item.rel);
      if (item.content != null) {
        writeSecureFile(dest, item.content, false);
      } else {
        secureCopy(item.abs, dest, false);
      }
      console.log(`  + ${item.rel}`);
    }

    writeFileSync(
      path.join(bundleDir, "README.txt"),
      [
        "ultraviris dev environment bundle",
        "",
        "Contains secrets. Keep private; do not commit to git.",
        "",
        "Import on another machine (from repo root):",
        "  node scripts/sync-dev-env.mjs import <this-bundle.tar.gz> --include-aws",
        "",
        "Optional:",
        "  --ssh-dest ~/.ssh/your-key",
        "  --dry-run",
      ].join("\n")
    );

    writeFileSync(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n"
    );

    for (const w of warnings) console.warn(`warning: ${w}`);

    if (items.length === 0) {
      console.error("Nothing to export. Create .env.local first (cp .env.example .env.local).");
      process.exit(1);
    }

    const outIsArchive = out.endsWith(".tar.gz") || out.endsWith(".tgz");
    if (outIsArchive) {
      mkdirSync(path.dirname(out), { recursive: true });
      if (!runTarCreate(out, bundleDir)) {
        console.error("tar failed; leaving unpacked bundle at:");
        const fallback = path.join(REPO_ROOT, `ultraviris-dev-bundle-${timestamp()}`);
        cpSync(bundleDir, fallback, { recursive: true });
        console.error(fallback);
        process.exit(1);
      }
      console.log(`\nExported archive: ${out}`);
    } else {
      cpSync(bundleDir, out, { recursive: true });
      console.log(`\nExported directory: ${out}`);
    }

    console.log(
      "\nSecurity: this bundle contains passwords and keys. Encrypt at rest and delete when done."
    );
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

function updateEnvValue(filePath, key, value, dryRun) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split("\n");
  let found = false;
  const updated = lines.map((line) => {
    if (line.match(new RegExp(`^\\s*${key}\\s*=`))) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) updated.push(`${key}=${value}`);
  if (dryRun) {
    console.log(`  would set ${key} in ${filePath}`);
    return;
  }
  writeFileSync(filePath, updated.join("\n"));
}

function mergeIniFile(destPath, srcContent, dryRun) {
  if (!existsSync(destPath)) {
    writeSecureFile(destPath, srcContent, dryRun);
    return;
  }
  if (dryRun) {
    console.log(`  would merge into ${destPath}`);
    return;
  }
  const existing = readFileSync(destPath, "utf8");
  if (!existing.endsWith("\n")) {
    writeSecureFile(destPath, existing + "\n" + srcContent, false);
  } else {
    writeSecureFile(destPath, existing + srcContent, false);
  }
}

function importBundle(bundleArg, { flags, options }) {
  const dryRun = flags.has("dry-run");
  const force = flags.has("force");
  const includeAws = flags.has("include-aws");
  const awsMerge = flags.has("aws-merge");
  const sshDest = expandHome(
    options["ssh-dest"] || path.join(homedir(), ".ssh", "ultraviris-db-key")
  );

  const bundleInput = path.resolve(bundleArg);
  if (!existsSync(bundleInput)) {
    console.error(`Bundle not found: ${bundleInput}`);
    process.exit(1);
  }

  let bundleRoot = bundleInput;
  let tempExtract = null;

  if (bundleInput.endsWith(".tar.gz") || bundleInput.endsWith(".tgz")) {
    tempExtract = mkdtempSync(path.join(REPO_ROOT, ".dev-bundle-import-"));
    if (!runTarExtract(bundleInput, tempExtract)) {
      console.error("Failed to extract archive. Ensure tar is available.");
      process.exit(1);
    }
    bundleRoot = findBundleRoot(tempExtract);
    if (!bundleRoot) {
      console.error("No manifest.json found in archive.");
      process.exit(1);
    }
  } else if (!existsSync(path.join(bundleInput, "manifest.json"))) {
    bundleRoot = findBundleRoot(bundleInput);
    if (!bundleRoot) {
      console.error("Not a valid bundle (missing manifest.json).");
      process.exit(1);
    }
  }

  const manifestPath = path.join(bundleRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== MANIFEST_VERSION) {
    console.warn(
      `warning: bundle manifest version ${manifest.version} (expected ${MANIFEST_VERSION})`
    );
  }

  console.log(`Importing bundle exported ${manifest.exportedAt} on ${manifest.platform}`);

  for (const rel of PROJECT_FILES) {
    const src = path.join(bundleRoot, rel);
    if (!existsSync(src)) continue;
    const dest = path.join(REPO_ROOT, rel);
    if (existsSync(dest) && !force && !dryRun) {
      console.error(`Refusing to overwrite ${rel} (use --force)`);
      process.exit(1);
    }
    if (dryRun) {
      console.log(`  would copy ${rel}`);
    } else {
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      chmodSync(dest, 0o600);
      console.log(`  + restored ${rel}`);
    }
  }

  const sshBundle = path.join(bundleRoot, "ssh", "private-key");
  if (existsSync(sshBundle)) {
    if (existsSync(sshDest) && !force && !dryRun) {
      console.error(`Refusing to overwrite SSH key at ${sshDest} (use --force)`);
      process.exit(1);
    }
    secureCopy(sshBundle, sshDest, dryRun);
    if (!dryRun) console.log(`  + installed SSH key at ${sshDest}`);

    const envLocal = path.join(REPO_ROOT, ".env.local");
    updateEnvValue(envLocal, "SSH_PRIVATE_KEY_PATH", sshDest, dryRun);
  }

  if (includeAws) {
    const credSrc = path.join(bundleRoot, "aws", "credentials");
    const configSrc = path.join(bundleRoot, "aws", "config");
    const awsDir = path.join(homedir(), ".aws");

    if (existsSync(credSrc)) {
      const dest = path.join(awsDir, "credentials");
      if (awsMerge) {
        mergeIniFile(dest, readFileSync(credSrc, "utf8"), dryRun);
      } else {
        secureCopy(credSrc, dest, dryRun);
      }
      if (!dryRun) console.log("  + restored ~/.aws/credentials");
    }
    if (existsSync(configSrc)) {
      const dest = path.join(awsDir, "config");
      if (awsMerge) {
        mergeIniFile(dest, readFileSync(configSrc, "utf8"), dryRun);
      } else {
        secureCopy(configSrc, dest, dryRun);
      }
      if (!dryRun) console.log("  + restored ~/.aws/config");
    }
  }

  const ghToken = path.join(bundleRoot, "gh", "token");
  if (existsSync(ghToken)) {
    const token = readFileSync(ghToken, "utf8").trim();
    if (dryRun) {
      console.log("  would run: gh auth login --with-token");
    } else {
      const gh = spawnSync("gh", ["auth", "login", "--with-token"], {
        input: token,
        encoding: "utf8",
      });
      if (gh.status === 0) {
        console.log("  + restored GitHub CLI auth");
      } else {
        console.warn(
          "  GitHub token present in bundle but gh restore failed. Run manually:\n" +
            "    gh auth login --with-token < bundle/gh/token"
        );
      }
    }
  }

  if (tempExtract) {
    rmSync(tempExtract, { recursive: true, force: true });
  }

  if (dryRun) {
    console.log("\nDry run complete.");
  } else {
    console.log("\nImport complete. Next steps:");
    console.log("  npm ci");
    console.log("  npm run dev");
    if (!includeAws && manifest.aws?.credentials) {
      console.log("  (bundle included AWS creds — re-run with --include-aws to restore)");
    }
  }
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function requireGh(dryRun) {
  if (dryRun) return;
  const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  if (gh.status !== 0) {
    console.error(
      "GitHub CLI (gh) is required and must be authenticated.\n" +
        "  Install: https://cli.github.com/\n" +
        "  Login:   gh auth login"
    );
    process.exit(1);
  }
}

function ghSecretSet(name, value, dryRun) {
  if (!value) return false;
  if (dryRun) {
    console.log(`  would set secret ${name} (${value.length} chars)`);
    return true;
  }
  const result = spawnSync("gh", ["secret", "set", name], {
    input: value,
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  if (result.status !== 0) {
    console.error(`Failed to set secret ${name}: ${result.stderr?.trim() || "unknown error"}`);
    return false;
  }
  console.log(`  + secret ${name}`);
  return true;
}

function isSensitiveEnvKey(key) {
  if (SENSITIVE_ENV_EXCLUDE.has(key)) return false;
  return SENSITIVE_ENV_PATTERN.test(key);
}

function resolveGhBlobContent(spec, { includeAws, noAws }) {
  if (spec.kind === "ssh") {
    const sshPath = resolveSshKeyPath();
    return sshPath ? readFileSync(sshPath, "utf8") : null;
  }
  if (spec.kind === "aws-credentials") {
    if (!includeAws || noAws) return null;
    const p = path.join(homedir(), ".aws", "credentials");
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  if (spec.kind === "aws-config") {
    if (!includeAws || noAws) return null;
    const p = path.join(homedir(), ".aws", "config");
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  const abs = path.join(REPO_ROOT, spec.rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

function collectSensitiveEnvSecrets() {
  const envLocal = path.join(REPO_ROOT, ".env.local");
  const values = readDotenv(envLocal);
  const secrets = [];
  for (const [key, value] of Object.entries(values)) {
    if (!value || !isSensitiveEnvKey(key)) continue;
    secrets.push({ name: `DEV_${key}`, value });
  }
  return secrets;
}

function pushGhSecrets({ flags }) {
  const dryRun = flags.has("dry-run");
  const includeAws = flags.has("include-aws");
  const noAws = flags.has("no-aws");

  requireGh(dryRun);

  if (!existsSync(path.join(REPO_ROOT, ".env.local"))) {
    console.error("Nothing to push. Create .env.local first (cp .env.example .env.local).");
    process.exit(1);
  }

  console.log("Pushing dev secrets to GitHub repository secrets...");
  let count = 0;

  for (const spec of GH_BLOB_SECRETS) {
    const content = resolveGhBlobContent(spec, { includeAws, noAws });
    if (!content) {
      if (spec.required) {
        console.error(`Required file missing for secret ${spec.name}`);
        process.exit(1);
      }
      console.warn(`warning: skipping ${spec.name} (source not found)`);
      continue;
    }
    if (ghSecretSet(spec.name, content, dryRun)) count++;
  }

  for (const { name, value } of collectSensitiveEnvSecrets()) {
    if (ghSecretSet(name, value, dryRun)) count++;
  }

  if (count === 0) {
    console.error("No secrets were pushed.");
    process.exit(1);
  }

  console.log(`\nPushed ${count} secret(s) to GitHub.`);
  if (dryRun) {
    console.log("Dry run complete.");
    return;
  }
  console.log(
    "\nOn another machine (after git clone + gh auth login):\n" +
      "  node scripts/sync-dev-env.mjs pull-gh --include-aws\n" +
      "\nNote: GitHub repo secrets cannot be read directly. pull-gh triggers\n" +
      "export-dev-secrets.yml to package them into a 1-day workflow artifact."
  );
}

function findArchiveInDir(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".tar.gz") || entry.endsWith(".tgz")) {
      return path.join(dir, entry);
    }
  }
  return null;
}

function pullGhSecrets({ flags, options }) {
  const dryRun = flags.has("dry-run");
  requireGh(dryRun);

  if (dryRun) {
    console.log(`would trigger workflow ${GH_WORKFLOW}`);
    console.log(`would download artifact ${GH_ARTIFACT} and import locally`);
    return;
  }

  console.log("Triggering GitHub workflow to package repo secrets...");
  const trigger = spawnSync("gh", ["workflow", "run", GH_WORKFLOW], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (trigger.status !== 0) {
    console.error(
      "Failed to trigger workflow:",
      trigger.stderr?.trim() || trigger.stdout?.trim() || "unknown error"
    );
    console.error(
      "\nEnsure export-dev-secrets.yml is pushed to the default branch and you have repo access."
    );
    process.exit(1);
  }

  sleep(4000);

  const list = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      GH_WORKFLOW,
      "--limit",
      "1",
      "--json",
      "databaseId,status",
      "-q",
      ".[0].databaseId",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const runId = list.stdout.trim();
  if (!runId || list.status !== 0) {
    console.error("Could not find workflow run id:", list.stderr?.trim());
    process.exit(1);
  }

  console.log(`Waiting for workflow run ${runId}...`);
  const watch = spawnSync("gh", ["run", "watch", runId], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (watch.status !== 0) {
    console.error("Workflow did not complete successfully.");
    process.exit(1);
  }

  const downloadDir = mkdtempSync(path.join(REPO_ROOT, ".dev-bundle-import-"));
  try {
    const dl = spawnSync(
      "gh",
      ["run", "download", runId, "-n", GH_ARTIFACT, "-D", downloadDir],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    if (dl.status !== 0) {
      console.error("Failed to download artifact:", dl.stderr?.trim());
      process.exit(1);
    }

    const archive = findArchiveInDir(downloadDir);
    if (!archive) {
      console.error(`No .tar.gz found in downloaded artifact (looked in ${downloadDir})`);
      process.exit(1);
    }

    console.log(`\nDownloaded bundle: ${archive}`);
    importBundle(archive, { flags, options });
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

function main() {
  const { positional, flags, options } = parseArgs(process.argv.slice(2));

  if (options.help || positional.length === 0) {
    usage();
    process.exit(positional.length === 0 ? 1 : 0);
  }

  const command = positional[0];

  if (command === "push-gh") {
    pushGhSecrets({ flags, options });
    return;
  }

  if (command === "pull-gh") {
    pullGhSecrets({ flags, options });
    return;
  }

  if (command === "export") {
    exportBundle({ flags, options });
    return;
  }

  if (command === "import") {
    if (!positional[1]) {
      console.error("Import requires a bundle path.\n");
      usage();
      process.exit(1);
    }
    importBundle(positional[1], { flags, options });
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  usage();
  process.exit(1);
}

main();
