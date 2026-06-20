# Deployment

The app builds to a self-contained Docker image (`output: "standalone"`).

| File | Role |
|------|------|
| `Dockerfile` | Multi-stage build, non-root, baked-in `HEALTHCHECK` |
| `Makefile` | `make push`, `make ship`, `make deploy`, `make sync-secrets` — run `make help` for all targets |
| `.github/workflows/branch-ci.yml` | **branch-CI** PR gate: tsc, lint, unit tests + cross-browser E2E (see below) |
| `.github/workflows/test.yml` | Type-check, lint, and unit tests on every PR |
| `.github/workflows/build-and-push.yml` | CI/CD pipeline: build → sync secrets → deploy (see below) |
| `scripts/sync-secrets.mts` | Validate + sync `.env.local`/CI env into the `ultraviris/env` secret |
| `scripts/ci-assemble-env.sh` | CI: rebuild the prod env from `APP_*` GitHub Secrets/Variables |
| `scripts/launch-ec2.sh` | Provisions a single Graviton instance |
| `scripts/userdata.sh` | EC2 user-data: Docker, secrets, first deploy, alert cron |
| `scripts/deploy.sh` | On-instance rollout: pull ECR tag, restart, health-check, rollback |

## Local Docker

```bash
make build           # build a local image for your host arch
make run             # runs with --env-file .env.local on :3000
make run-local       # same, but mounts the SSH key so the DB tunnel works
npm test             # unit tests
npm run build && npm run test:e2e:install && npm run test:e2e   # Playwright E2E
```

> `make build` / `make run` / `make run-local` first run `make github-token-local`,
> which writes `GITHUB_TOKEN` into `.env.local` from your authenticated `gh` CLI
> so the admin issue reporter works locally. Use **`make run-local`** (not
> `make run`) when `.env.local` sets `SSH_HOST` — only it mounts the key needed
> for the DB tunnel.

## Continuous deployment (merge → CI → ECR → EC2)

On every push to `main`, `build-and-push.yml` runs three chained jobs:

1. **test** – `tsc`, `lint`, `npm test`. Everything below is gated on this passing.
2. **build** – builds the `linux/arm64` image and pushes it to ECR tagged with the
   git short SHA **and** `latest` (immutable SHA tag is what gets deployed).
3. **deploy** – **mirrors `make ship`**: it rebuilds the production env from the
   repo's `APP_*` GitHub Secrets/Variables (`scripts/ci-assemble-env.sh`),
   validates it, and writes it to the `ultraviris/env` Secrets Manager secret
   (`sync-secrets --apply`). It then pins the sha in SSM (`/ultraviris/image-tag`)
   and runs a **zero-downtime ASG instance refresh** (`MinHealthyPercentage=100`):
   new instances launch, re-read the secret + pull that sha, and must pass the ALB
   health check before old ones drain. If the rollout fails it reverts the tag
   pointer **and rolls the secret back** to its previous version. With no ASG it
   falls back to an in-place **SSM Run Command** running
   `/opt/ultraviris/deploy.sh <sha>` on instances tagged `App=ultraviris`.

All AWS access is via GitHub OIDC (the `AWS_ROLE_ARN` repo secret) — no static keys.
Tag pushes (`v*`) publish to ECR but do **not** auto-deploy.

### Secrets

The app's runtime env lives in the `ultraviris/env` Secrets Manager secret, which
instances read at boot (`scripts/userdata.sh`). Both local and CD paths keep it
in sync from a dotenv source, **non-destructively** and **validated**:

- **`make ship`** reads your `.env.local`.
- **CI deploy** reads the repo's `APP_*` Secrets/Variables (the CI equivalent of
  `.env.local`). Populate/refresh them with `make push-github-env` (needs `gh`).
  Keys are stored under an `APP_` prefix because GitHub reserves `GITHUB_`;
  sensitive keys + infra identifiers become **Secrets**, the rest **Variables**;
  local-only keys (`SSH_PRIVATE_KEY_PATH`, static `AWS_*` creds) are skipped.

`scripts/sync-secrets.mts` merges the source over the current secret (existing
keys are never dropped; an empty local value never blanks a non-empty prod one),
runs `lib/env-secrets.ts` validation (required keys present, `ADMIN_SESSION_SECRET`
length, no `localhost` in `MYSQL_HOST`/`SSH_HOST`/`IMAGE_BASE_URL`, etc.), and
aborts the deploy if validation fails. Preview anytime with `make sync-secrets`
(dry-run, redacted diff).

### branch-CI (PR gate)

`branch-ci.yml` runs on **pull requests targeting `main`** and is the merge gate:

- **tests** – `tsc --noEmit`, `eslint`, full `vitest` suite.
- **e2e** – builds the app, then runs **Playwright** across Desktop
  Chrome/Firefox/Safari and Mobile Chrome/Safari, crawling every public page to
  assert it renders and that internal links resolve (and external links aren't
  dead). The HTML report is uploaded as an artifact.

To actually block merges, add **`tests`** and **`e2e`** as **required status
checks** in the `main` branch protection rule (Settings → Branches). No DB exists
in CI, so the resilient data loaders return empty and pages still render their
layout shell.

**First-time setup:**

```bash
./scripts/setup-aws.sh     # ECR, S3, secrets, OIDC role, instance profile, deploy.sh
./scripts/launch-ec2.sh    # launches the app server, tagged App=ultraviris
# add the printed AWS_ROLE_ARN as a GitHub Actions repo secret, then push to main
```

See [AWS setup](aws-setup.md) for what `setup-aws.sh` provisions.

## Manual deploy

Both commands run the same rollout logic as CI — zero-downtime ASG instance refresh
if an ASG exists, in-place SSM otherwise, with automatic revert of the SSM tag
pointer on failure:

```bash
make ship                        # validate+sync secrets, build, push to ECR, roll it out
make deploy TAG=<git-short-sha>  # roll out an already-pushed tag (or TAG=latest)
make sync-secrets                # dry-run: preview the .env.local -> ultraviris/env diff
```

`make ship` is the full local CD path that bypasses GitHub entirely: it validates
and syncs `.env.local` into `ultraviris/env`, builds + pushes, rolls out, and
rolls the secret back if the deploy is unhealthy. `make deploy` just
re-points/rolls out an existing image without touching secrets (handy for
rollbacks).

## Production topology: ALB + Auto Scaling Group + HTTPS

`scripts/setup-alb-asg.sh` (or `make setup-alb-asg`) provisions the load-balanced
production setup:

```
Internet ─443─▶ ALB (ACM cert for nataliernathan.com) ─80─▶ ASG instances :80 ─▶ container :3000
          ─80─▶ ALB (redirect → 443)
```

It creates: an `ultraviris-alb` security group (public 80/443), an `ultraviris-app`
SG that only accepts :80 from the ALB, a launch template (AL2023 ARM64 + the
instance profile + `userdata.sh`, instances tagged `App=ultraviris`), a target
group health-checking `/api/health/status`, the ALB with an HTTPS:443 listener
(ACM cert) and an HTTP:80→443 redirect, an Auto Scaling Group (default `1/1/2`)
with a **target-tracking CPU scaling policy** (`CPU_TARGET`, default 50%), and an
SSM parameter `/ultraviris/image-tag` that instances read on boot to know which
image to run. The CD pipeline updates that parameter and triggers an instance
refresh, so both rolling deploys and ASG scale-out launches come up on the exact
deployed sha.

### DNS (separate AWS account)

DNS lives in a different AWS account (`116851791213`). RAM can't share a hosted
zone, so `scripts/setup-dns.sh` writes the records into that account. Pick one
access method:

**Direct profile (simplest):**

```bash
DNS_PROFILE=network_ultraviris_access make dns
```

**Cross-account role:**

```bash
AWS_PROFILE=network_ultraviris_access make dns-create-role   # creates ultraviris-dns-manager
make dns                                                     # app creds assume the role
```

**Provisioning sequence** (ACM/ALB reads use app-account creds; only zone writes
use `DNS_PROFILE`/the role):

```bash
CERT_WAIT=0 make setup-alb-asg                       # 1) request ACM cert (prints validation CNAME)
DNS_PROFILE=network_ultraviris_access make dns       # 2) write the validation CNAME
make setup-alb-asg                                   # 3) cert validates → build ALB/listeners/ASG
DNS_PROFILE=network_ultraviris_access make dns       # 4) ALB exists → write the apex A/ALIAS
```

`make dns` is idempotent — it adds whatever's ready (validation CNAME first, apex
alias once the ALB exists) and waits for the change to go INSYNC. (For the
role-based path, `ROLE_EXTERNAL_ID` adds an extra assume-role guard.)

> Tune sizing/instance type via `ASG_MIN` / `ASG_DESIRED` / `ASG_MAX` /
> `INSTANCE_TYPE` in `scripts/aws-setup.config`. If you previously ran
> `make launch-ec2`, terminate that standalone instance — it isn't behind the ALB.
