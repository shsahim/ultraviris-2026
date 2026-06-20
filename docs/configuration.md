# Configuration

Copy `.env.example` to `.env.local` and fill in values before running locally:

```bash
cp .env.example .env.local
```

See [dev environment sync](dev-environment-sync.md) for moving `.env.local` and
keys between machines.

## Database (MySQL over SSH)

The app connects to MySQL through an SSH tunnel ("Standard TCP/IP over SSH",
the same model MySQL Workbench uses) via [`mysql2`](https://github.com/sidorares/node-mysql2)
and [`ssh2`](https://github.com/mscdex/ssh2). `lib/db.ts` opens an SSH connection
using a locally-stored private key, forwards a local port to the remote MySQL
host, and connects the pool through it.

**SSH tunnel** (the bastion/host you SSH into):

- `SSH_HOST`, `SSH_PORT` (default `22`), `SSH_USER`
- `SSH_PRIVATE_KEY_PATH` – path to your local private key (`~` is expanded)
- `SSH_PASSPHRASE` – only if the key is encrypted

**MySQL** as seen *from the SSH server* (for RDS in a private VPC, this is the
RDS endpoint):

- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`

Use the `query` helper in server-side code only (Server Components, Route
Handlers, Server Actions):

```ts
import { query } from "@/lib/db";

const users = await query("SELECT * FROM users WHERE id = ?", [1]);
```

Verify the connection from **Admin → Site Health**, which shows database status
and per-table row counts.

> `lib/db.ts` is server-only. Never import it from Client Components. The tunnel
> opens lazily on the first query and is reused; if the SSH connection drops,
> the next query rebuilds it.

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
