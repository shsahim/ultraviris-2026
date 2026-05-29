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

A password-protected admin area for non-technical editing of the database.

Set in `.env.local`:

- `ADMIN_PASSWORD` – the password used to sign in
- `ADMIN_SESSION_SECRET` – a long random string used to sign the session cookie

Features:

- **Site Health** – database connection status and per-table row counts.
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
- `.github/workflows/build-and-push.yml` – builds ARM64 and pushes to ECR via
  GitHub OIDC.
- `scripts/userdata.sh` – EC2 (Amazon Linux 2023) user-data: installs Docker,
  pulls secrets + image, runs the container with startup health checks, and
  installs the alert cron.

Run locally in Docker:

```bash
make build           # build a local image for your host arch
make run             # runs with --env-file .env.local on :3000
npm test             # unit tests
```

## AWS setup script (issues #1–4, #6–8)

Automates most production AWS resources. **Does not** create EC2 / ASG / ALB
(GitHub issue #5).

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
| #4 GitHub | OIDC provider + IAM role for Actions → outputs `AWS_ROLE_ARN` for repo secret |
| #6 Secrets | `ultraviris/env` and `ultraviris/ssh-key` in Secrets Manager |
| #7 Health cron | Optional Lambda + EventBridge every 5 min if `HEALTH_CRON_URL` is set |
| #8 TLS | Optional ACM cert + Route 53 validation records if `DOMAIN_NAME` / `HOSTED_ZONE_ID` set |
| (prep) | EC2 instance IAM role + instance profile for launch template (not instances themselves) |

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
