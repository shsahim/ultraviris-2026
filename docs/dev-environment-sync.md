# Dev environment sync

Local dev depends on files that are gitignored: `.env.local`, your SSH private
key, `scripts/aws-setup.config`, and optionally AWS CLI credentials. Use
`scripts/sync-dev-env.mjs` to move that setup to a new computer.

**Prerequisites:** [GitHub CLI](https://cli.github.com/) (`gh auth login`) for
the GitHub-backed flow. Node.js only (no extra packages) — works on macOS,
Linux, and Windows.

## Option A — GitHub repo secrets (recommended)

Store passwords, API keys, and private keys in GitHub, then pull them on the
new machine. GitHub does not let you read secret values back via the API, so
`pull-gh` triggers `.github/workflows/export-dev-secrets.yml`, which packages
the secrets into a **1-day workflow artifact** you download locally.

**On your current machine** (after filling in `.env.local`):

```bash
npm run env:push-gh
# or, without AWS CLI files:
node scripts/sync-dev-env.mjs push-gh
```

This uploads:

| GitHub secret | Contents |
|---|---|
| `DEV_ENV_LOCAL` | Full `.env.local` |
| `DEV_SSH_PRIVATE_KEY` | SSH private key (from `SSH_PRIVATE_KEY_PATH` or `SSH_KEY_FILE`) |
| `DEV_AWS_SETUP_CONFIG` | `scripts/aws-setup.config` |
| `DEV_AWS_SETUP_OUTPUTS` | `scripts/aws-setup-outputs.env` |
| `DEV_AWS_CREDENTIALS` / `DEV_AWS_CONFIG` | AWS CLI files (with `--include-aws`) |
| `DEV_*` (per key) | Individual sensitive env vars (`MYSQL_PASSWORD`, `ADMIN_PASSWORD`, etc.) |

**On the new machine:**

```bash
git clone <repo-url>
cd ultraviris-2026
gh auth login
npm run env:pull-gh
npm ci
npm run dev
```

Useful flags:

- `push-gh --dry-run` — preview what would be uploaded
- `pull-gh --ssh-dest ~/.ssh/my-key` — where to install the SSH key
- `pull-gh --aws-merge` — merge AWS profiles instead of overwriting
- `pull-gh --force` — overwrite existing local files

> **Security:** Repo collaborators who can run workflows can trigger the export
> and download the artifact. Limit repo access accordingly. The workflow file
> must be on the default branch before `pull-gh` works.

## Option B — Local archive (offline / no GitHub)

Create a `.tar.gz` bundle you copy via USB, cloud storage, etc.:

```bash
npm run env:export
# transfer securely, then on the new machine:
node scripts/sync-dev-env.mjs import ./ultraviris-dev-bundle-*.tar.gz --include-aws
```

Local archives are **not encrypted**. Treat them like a password manager export:
encrypt at rest, delete when done, never commit to git.
