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

- `AWS_REGION` – the SES region (e.g. `us-east-1`)
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
