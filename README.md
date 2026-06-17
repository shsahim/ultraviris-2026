# ultraviris-2026

A very simple Next.js + React web app with a white background and black text.

## Getting started

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Scripts

- `npm run dev` – start the development server
- `npm run build` – build for production
- `npm run start` – run the production build

## Database (MySQL over SSH)

This app connects to MySQL through an SSH tunnel ("Standard TCP/IP over SSH",
the same model MySQL Workbench uses) via [`mysql2`](https://github.com/sidorares/node-mysql2)
and [`ssh2`](https://github.com/mscdex/ssh2). `lib/db.ts` opens an SSH connection
using a locally-stored private key, forwards a local port to the remote MySQL
host, and connects the pool through it.

1. Copy `.env.example` to `.env.local` and fill in your credentials:

```bash
cp .env.example .env.local
```

2. Configure the **SSH tunnel** (the bastion/host you SSH into):

   - `SSH_HOST`, `SSH_PORT` (default `22`), `SSH_USER`
   - `SSH_PRIVATE_KEY_PATH` – path to your local private key (`~` is expanded)
   - `SSH_PASSPHRASE` – only if the key is encrypted

3. Configure **MySQL** as seen *from the SSH server* (for RDS in a private VPC,
   this is the RDS endpoint, since the SSH host can reach it):

   - `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`

4. Use the `query` helper in any server-side code (Server Components, Route
   Handlers, Server Actions):

```ts
import { query } from "@/lib/db";

const users = await query("SELECT * FROM users WHERE id = ?", [1]);
```

5. Verify the connection from the **admin page** (`/admin` → Site Health), which
   shows whether the database is connected and the row counts per table.

> Note: `lib/db.ts` is server-only. Never import it from Client Components. The
> tunnel is opened lazily on the first query and reused across requests; if the
> SSH connection drops, the next query rebuilds it.

## Admin page (`/admin`)

A username/password-protected admin area for non-technical editing of the
database.

Admin accounts live in the `admin_users` table, with passwords hashed using
scrypt (`lib/admin-users.ts`). The table is created automatically on first use.
To bootstrap the first account, set these in `.env.local` (or the `ultraviris/env`
secret); when `admin_users` is empty, an initial account is seeded from them:

- `ADMIN_USERNAME` – username for the seeded initial admin (default: `admin`)
- `ADMIN_PASSWORD` – password for the seeded initial admin (only used to create
  the first account; afterwards manage passwords from the admin UI)
- `ADMIN_SESSION_SECRET` – a long random string used to sign the session cookie.
  The session token is bound to the user's password hash, so changing a
  password (or this secret) invalidates that user's existing sessions.

Features:

- **Site Health** – database connection status and per-table row counts.
- **Admin users** – list accounts, add users, change passwords, and delete users
  (you can't delete the last account or the one you're signed in as).
- **Manage data** – pick any table, browse rows (paginated), edit existing
  entries, add new entries, and flip an `is_active` column between
  Active/Inactive with one click.

The data editor is schema-driven (it reads `information_schema`), so it works
for every table automatically. Table and column names are validated against the
live schema before any query runs.

## Contact form email (Amazon SES)

The contact form (`/contact`) posts to `app/api/contact/route.ts`, which sends an
email via [Amazon SES](https://docs.aws.amazon.com/ses/) using `lib/email.ts`.

Set these in `.env.local`:

- `AWS_REGION` – the SES region (e.g. `us-west-2`)
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` – IAM credentials with the
  `ses:SendEmail` permission
- `SES_FROM_EMAIL` – a sender address/domain **verified** in SES
- `CONTACT_TO_EMAIL` – where messages are delivered (defaults to
  `ultraviris@gmail.com`)

Notes:

- While your SES account is in the **sandbox**, both the sender *and* recipient
  addresses must be verified in SES. Request production access to email any
  recipient.
- The visitor's email is set as the `Reply-To`, so you can reply directly.
- If `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are omitted, the SDK falls
  back to the default AWS credential chain (useful on AWS infrastructure).

## Health monitoring & alerts

The app self-monitors and can email alerts when a subsystem breaks. See
`lib/health.ts` (the checks), `lib/monitor.ts` (alerting logic), and the routes
below.

- `GET /api/health/status` – lightweight public liveness probe (`200`/`503`).
  Point an external uptime monitor (UptimeRobot, Pingdom, ALB health check) here.
- `POST|GET /api/health/cron` – runs all checks and emails alerts. Protected by
  `HEALTH_CHECK_SECRET` (sent as `Authorization: Bearer <secret>` or `?token=`).
  Call it from a single scheduler (cron / EventBridge) every few minutes.

Alert config (`.env.local` / production env):

- `ALERT_EMAIL` – where alerts are sent (falls back to `CONTACT_TO_EMAIL`)
- `ALERT_RESEND_MINUTES` – reminder interval for a still-failing check (default 60)
- `HEALTH_CHECK_SECRET` – shared secret for the cron endpoint

Dedup/throttle state is stored in a `health_alerts` table (auto-created), so an
autoscaled fleet won't send duplicate emails.

## Deployment (Docker on EC2 / Graviton ARM64)

The app builds to a self-contained image (`output: "standalone"`).

- `Dockerfile` – multi-stage build, non-root, with a baked-in `HEALTHCHECK`.
- `Makefile` – `make push` builds `linux/arm64` and pushes to ECR; `make help`
  lists all targets.
- `.github/workflows/test.yml` – type-check, lint, and unit tests on every PR.
- `.github/workflows/build-and-push.yml` – the **CI/CD pipeline** (see below).
- `scripts/launch-ec2.sh` – provisions a single Graviton instance that runs the app.
- `scripts/userdata.sh` – EC2 (Amazon Linux 2023) user-data: installs Docker,
  pulls secrets, fetches `deploy.sh`, runs the first deploy, installs the alert cron.
- `scripts/deploy.sh` – runs **on the instance**: pulls a tag from ECR, restarts
  the container, waits for health, and rolls back on failure. Shared by the boot
  script and the deploy pipeline.

Run locally in Docker:

```bash
make build           # build a local image for your host arch
make run             # runs with --env-file .env.local on :3000
npm test             # unit tests
```

### Continuous deployment (merge → CI → ECR → EC2)

On every push to `main`, `build-and-push.yml` runs three chained jobs:

1. **test** – `tsc`, `lint`, `npm test` (same checks PRs get). Everything below is
   gated on this passing.
2. **build** – builds the `linux/arm64` image and pushes it to ECR tagged with the
   git short SHA **and** `latest` (immutable SHA tag is what gets deployed).
3. **deploy** – pins the deployed sha in SSM Parameter Store (`/ultraviris/image-tag`),
   then performs a **zero-downtime ASG instance refresh** (`MinHealthyPercentage=100`):
   new instances launch, pull that sha, and must pass the ALB health check before old
   ones are drained. If the refresh fails the job reverts the tag pointer. When no ASG
   exists (e.g. the simple single-instance setup), it falls back to an in-place **SSM
   Run Command** that runs `/opt/ultraviris/deploy.sh <sha>` on instances tagged
   `App=ultraviris` (with per-instance health-check + rollback).

All AWS access is via GitHub OIDC (the `AWS_ROLE_ARN` repo secret) — no static keys.
Tag pushes (`v*`) publish to ECR but do **not** auto-deploy.

First-time setup:

```bash
./scripts/setup-aws.sh     # ECR, S3, secrets, OIDC role (ECR push + SSM deploy),
                           # EC2 instance profile (+ SSM core), uploads deploy.sh
./scripts/launch-ec2.sh    # launches the app server, tagged App=ultraviris
# add the printed AWS_ROLE_ARN as a GitHub Actions repo secret, then push to main
```

Manual deploy (outside the pipeline). Both run the same rollout logic as CI —
zero-downtime ASG instance refresh if an ASG exists, in-place SSM otherwise,
with automatic revert of the SSM tag pointer on failure:

```bash
make ship                        # build the current commit, push to ECR, roll it out
make deploy TAG=<git-short-sha>  # roll out an already-pushed tag (or TAG=latest); no build
```

`make ship` is the full local CD path that bypasses GitHub entirely; `make deploy`
just re-points/rolls out an existing image (handy for rollbacks).

### Production topology: ALB + Auto Scaling Group + HTTPS

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

**DNS lives in a different AWS account** (`116851791213`). RAM can't share a hosted
zone, so `scripts/setup-dns.sh` writes the records into that account. There are two
ways to give it access — pick one:

- **Direct profile (simplest):** add an AWS CLI profile with write access to the
  DNS-account zone and set `DNS_PROFILE`. No role/trust setup needed:

  ```bash
  DNS_PROFILE=network_ultraviris_access make dns
  ```

- **Cross-account role:** one-time in the DNS account, create a role the app
  account assumes (the caller also needs `sts:AssumeRole` on that role ARN):

  ```bash
  AWS_PROFILE=network_ultraviris_access make dns-create-role   # creates ultraviris-dns-manager
  make dns                                                     # app creds assume the role
  ```

Provisioning sequence (ACM/ALB reads always use app-account creds; only the zone
writes use `DNS_PROFILE`/the role):

```bash
CERT_WAIT=0 make setup-alb-asg                       # 1) request ACM cert (prints validation CNAME)
DNS_PROFILE=network_ultraviris_access make dns       # 2) write the validation CNAME
make setup-alb-asg                                   # 3) cert validates → build ALB/listeners/ASG
DNS_PROFILE=network_ultraviris_access make dns       # 4) ALB exists → write the apex A/ALIAS
```

`make dns` is idempotent — it adds whatever's ready (validation CNAME first, apex
alias once the ALB exists) and waits for the change to go INSYNC. (For the
role-based path, `ROLE_EXTERNAL_ID` adds an extra assume-role guard.) Then browse
`https://nataliernathan.com/`.

> Tune sizing/instance type via `ASG_MIN` / `ASG_DESIRED` / `ASG_MAX` /
> `INSTANCE_TYPE` in `scripts/aws-setup.config`. If you previously ran
> `make launch-ec2`, terminate that standalone instance — it isn't behind the ALB.


## AWS setup script (issues #1–4, #6–8)

Automates most production AWS resources. A single app instance is then launched
with `scripts/launch-ec2.sh`; a load-balanced ASG (GitHub issue #5) is still optional.

```bash
cp scripts/aws-setup.config.example scripts/aws-setup.config
# Edit: SES_FROM_EMAIL, SSH_KEY_FILE, ENV_SOURCE_FILE (.env.local), optional DOMAIN_NAME

aws configure   # IAM user with permissions listed in scripts/setup-aws.sh header
./scripts/setup-aws.sh
```

Creates (idempotently where possible):

| Issue | What the script does |
|-------|----------------------|
| #1 S3 | Bucket, public-read policy for images, CORS, optional `aws s3 sync` of `public/images/` |
| #2 SES | Starts verification for sender/recipients (you still click email links + request production access) |
| #3 ECR | Repository `ultraviris` |
| #4 GitHub | OIDC provider + IAM role for Actions (ECR push **and** SSM deploy) → outputs `AWS_ROLE_ARN` for repo secret |
| #6 Secrets | `ultraviris/env` and `ultraviris/ssh-key` in Secrets Manager |
| #7 Health cron | Optional Lambda + EventBridge every 5 min if `HEALTH_CRON_URL` is set |
| #8 TLS | Optional ACM cert + Route 53 validation records if `DOMAIN_NAME` / `HOSTED_ZONE_ID` set |
| EC2 IAM | Instance role + profile (ECR pull, Secrets, S3, SES) **+ `AmazonSSMManagedInstanceCore`** so the deploy pipeline can reach it |
| ops | Uploads `scripts/deploy.sh` to `s3://<bucket>/ops/deploy.sh` for instances + pipeline |

Outputs are written to `scripts/aws-setup-outputs.env`. DB path fix (issue #9):

```bash
npx tsx scripts/fix-file-locations.mts --dry-run
npx tsx scripts/fix-file-locations.mts
```

---

## ⚠️ Remaining setup TODOs (require external resources / info we don't have yet)

These are the things that still need real values or AWS resources before the app
is fully production-ready. Fill in the corresponding env vars and AWS config.

### 1. Amazon S3 (image storage) — **TODO**

Local uploads in `public/images/` do **not** persist or shard across an
autoscaled fleet, so production must use S3.

- [ ] Create an S3 bucket for artwork images.
- [ ] Decide on public access strategy: a public bucket/CloudFront CDN, or
      private with signed URLs (current code expects publicly-readable URLs).
- [ ] Set `S3_BUCKET` (enables admin uploads to S3 via `lib/storage.ts`).
- [ ] Set `IMAGE_BASE_URL` to the bucket/CDN base
      (e.g. `https://<bucket>.s3.<region>.amazonaws.com` or a CloudFront domain)
      so stored `File_Location` values resolve to S3 URLs.
- [ ] Grant the runtime IAM role `s3:PutObject` (uploads) and, if private,
      `s3:GetObject` on the bucket.
- [ ] **Migrate existing local images** in `public/images/**` into the bucket,
      preserving the same relative paths.

> Note: the local `.jpg`/`.png` extension-fallback in `lib/data.ts` only works
> for local files. Once on S3, the stored `File_Location` extensions must match
> the real objects — see the data-fix TODO below.

### 2. Amazon SES (email) — **TODO**

- [ ] Verify the sender identity (domain or address) in SES; set `SES_FROM_EMAIL`.
- [ ] **Request SES production access** (move out of the sandbox) so the contact
      form and alerts can email arbitrary recipients.
- [ ] Set `CONTACT_TO_EMAIL` (contact form destination) and `ALERT_EMAIL`
      (ops alerts).
- [ ] On EC2, prefer the instance role for `ses:SendEmail` and leave
      `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` unset (default cred chain).

### 3. Amazon ECR (image registry) — **TODO**

- [ ] Create the ECR repository (`make ecr-create`, or via console/IaC). Default
      name is `ultraviris` — update `ECR_REPO` in `Makefile`,
      `build-and-push.yml`, and `scripts/userdata.sh` if you change it.
- [ ] Confirm `AWS_REGION` is consistent across the `Makefile`, the workflow,
      and `userdata.sh`.

### 4. GitHub Actions ↔ AWS (OIDC) — **TODO**

- [ ] Create an IAM OIDC identity provider for GitHub Actions.
- [ ] Create a deploy role trusted by this repo (scope the trust policy to
      `repo:<owner>/<repo>:*`) with ECR push permissions.
- [ ] Add the repo secret **`AWS_ROLE_ARN`** with that role's ARN.

### 5. EC2 / Auto Scaling Group — **TODO**

- [ ] Build a launch template using an **ARM64 / Graviton** instance type
      (e.g. `t4g`/`c7g`) and Amazon Linux 2023, with `scripts/userdata.sh` as
      user-data (edit the config vars at the top).
- [ ] Attach an **instance IAM role** with:
      `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`,
      `ecr:GetDownloadUrlForLayer`, `secretsmanager:GetSecretValue` (the two
      secrets below), plus `ses:SendEmail` and scoped `s3:*` if using the role.
- [ ] Create an **Application Load Balancer** with health check path
      `/api/health/status`; put the ASG behind it.
- [ ] Security groups: ALB → instances on the app port; instances must reach the
      **SSH bastion** for the DB tunnel and AWS APIs (SES/S3/ECR/Secrets Mgr).

### 6. AWS Secrets Manager — **TODO**

`scripts/userdata.sh` expects two secrets:

- [ ] **`ultraviris/env`** – dotenv-formatted text containing the full runtime
      environment (a filled-in copy of `.env.example`, including
      `HEALTH_CHECK_SECRET`, DB/SSH, SES, S3, admin secrets).
- [ ] **`ultraviris/ssh-key`** – the SSH private key PEM used for the DB tunnel
      (mounted read-only at `/run/ssh_key.pem`; `SSH_PRIVATE_KEY_PATH` is set to
      that path by user-data).
- [ ] Rename the secrets? Update `ENV_SECRET` / `SSH_KEY_SECRET` in
      `scripts/userdata.sh`.

### 7. Scheduled health checks in production — **TODO**

- [ ] Either keep the per-instance host cron from `userdata.sh`, **or** (preferred
      for a large ASG) create a single **EventBridge Scheduler** that POSTs to
      `https://<your-domain>/api/health/cron` with the `HEALTH_CHECK_SECRET`.
- [ ] Point an external uptime monitor at `/api/health/status`.

### 8. Domain, TLS & secrets hygiene — **TODO**

- [ ] Register/route the domain (Route 53) to the ALB; issue a TLS cert (ACM)
      and add an HTTPS listener.
- [ ] Generate a strong `ADMIN_PASSWORD` and a long random `ADMIN_SESSION_SECRET`
      and `HEALTH_CHECK_SECRET` for production (do not reuse dev values).
- [ ] Ensure `.env.local` and `*.pem` are never committed (already gitignored).

### 9. Database content fix (extensions) — **TODO**

Some `File_Location` values in the DB end in `.png` while the real files are
`.jpg` (the gallery currently compensates locally, but S3 won't).

- [ ] Run a one-time script to correct `File_Location` extensions to match the
      actual objects before/at the S3 migration. (Happy to generate this script.)

### 10. Runtime / housekeeping — **nice to have**

- [ ] Bump local dev Node to **22 LTS** (CI and Docker already use 22; the AWS
      SDK warns on Node 21 and it broke newer tooling).
- [ ] Add log shipping/metrics (CloudWatch agent) if you want dashboards beyond
      the in-app Site Health page.
