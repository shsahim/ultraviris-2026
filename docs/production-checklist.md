# Production checklist

Remaining setup items that need real values or AWS resources before the app is
fully production-ready. Fill in the corresponding env vars and AWS config.

## 1. Amazon S3 (image storage)

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

> `lib/resolve-image.ts` fuzzy-matches stored `File_Location` values to real
> objects (exact → extension swap → same-folder basename → unique prefix) for
> **both** local files and S3, and with `IMAGE_AUTOHEAL` on it writes the
> corrected value back to the DB. A bulk fix script is still available — see
> [AWS setup](aws-setup.md#data-fix-scripts).

## 2. Amazon SES (email)

- [ ] Verify the sender identity (domain or address) in SES; set `SES_FROM_EMAIL`.
- [ ] **Request SES production access** (move out of the sandbox) so the contact
      form and alerts can email arbitrary recipients.
- [ ] Set `CONTACT_TO_EMAIL` (contact form destination) and `ALERT_EMAIL`
      (ops alerts).
- [ ] On EC2, prefer the instance role for `ses:SendEmail` and leave
      `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` unset (default cred chain).

## 3. Amazon ECR (image registry)

- [ ] Create the ECR repository (`make ecr-create`, or via console/IaC). Default
      name is `ultraviris` — update `ECR_REPO` in `Makefile`,
      `build-and-push.yml`, and `scripts/userdata.sh` if you change it.
- [ ] Confirm `AWS_REGION` is consistent across the `Makefile`, the workflow,
      and `userdata.sh`.

## 4. GitHub Actions ↔ AWS (OIDC)

- [ ] Create an IAM OIDC identity provider for GitHub Actions.
- [ ] Create a deploy role trusted by this repo (scope the trust policy to
      `repo:<owner>/<repo>:*`) with ECR push permissions.
- [ ] Add the repo secret **`AWS_ROLE_ARN`** with that role's ARN.

## 5. EC2 / Auto Scaling Group

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

## 6. AWS Secrets Manager

`scripts/userdata.sh` expects two secrets:

- [ ] **`ultraviris/env`** – dotenv-formatted text containing the full runtime
      environment (a filled-in copy of `.env.example`, including
      `HEALTH_CHECK_SECRET`, DB/SSH, SES, S3, admin secrets).
- [ ] **`ultraviris/ssh-key`** – the SSH private key PEM used for the DB tunnel
      (mounted read-only at `/run/ssh_key.pem`; `SSH_PRIVATE_KEY_PATH` is set to
      that path by user-data).
- [ ] Rename the secrets? Update `ENV_SECRET` / `SSH_KEY_SECRET` in
      `scripts/userdata.sh`.
- [ ] You don't hand-edit `ultraviris/env`: `make ship` (from `.env.local`) and
      the CI deploy (from `APP_*` repo Secrets/Variables) validate and sync it
      automatically, non-destructively. Run `make push-github-env` once to seed
      the CI source. See [deployment](deployment.md#secrets).

## 7. Scheduled health checks in production

- [ ] Either keep the per-instance host cron from `userdata.sh`, **or** (preferred
      for a large ASG) create a single **EventBridge Scheduler** that POSTs to
      `https://<your-domain>/api/health/cron` with the `HEALTH_CHECK_SECRET`.
- [ ] Point an external uptime monitor at `/api/health/status`.

## 8. Domain, TLS & secrets hygiene

- [ ] Register/route the domain (Route 53) to the ALB; issue a TLS cert (ACM)
      and add an HTTPS listener.
- [ ] Generate a strong `ADMIN_PASSWORD` and a long random `ADMIN_SESSION_SECRET`
      and `HEALTH_CHECK_SECRET` for production (do not reuse dev values).
- [ ] Ensure `.env.local` and `*.pem` are never committed (already gitignored).
- [ ] (Optional) Set `GITHUB_TOKEN` (fine-grained PAT, Issues: Read & write) and
      `GITHUB_ISSUE_REPO` to enable the admin "Report an issue" popout.

## 9. Database content fix (extensions)

Some `File_Location` values in the DB end in `.png` while the real files are
`.jpg` (the resolver now compensates for both local and S3 at runtime, and
self-heals the DB when `IMAGE_AUTOHEAL` is on).

- [ ] Run a one-time script to correct `File_Location` extensions to match the
      actual objects before/at the S3 migration. See [AWS setup](aws-setup.md#data-fix-scripts).

> With `IMAGE_AUTOHEAL` on, the resolver also corrects these at runtime (fuzzy
> match + write-back) as pages load, so the bulk script is now optional cleanup
> rather than a hard blocker.

## 10. Runtime / housekeeping (nice to have)

- [ ] Bump local dev Node to **22 LTS** (CI and Docker already use 22; the AWS
      SDK warns on Node 21 and it broke newer tooling).
- [ ] Add log shipping/metrics (CloudWatch agent) if you want dashboards beyond
      the in-app Site Health page.
