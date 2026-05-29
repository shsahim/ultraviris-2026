#!/bin/bash
#
# Creates GitHub issues for the remaining production setup TODOs.
#
# Requirements:
#   * GitHub CLI installed and authenticated:
#       brew install gh && gh auth login
#   * Run from anywhere inside the repo (defaults to the current repo's origin).
#
# Usage:
#   ./scripts/create-issues.sh
#   REPO=shsahim/ultraviris-2026 ./scripts/create-issues.sh   # explicit repo
#
set -euo pipefail

REPO="${REPO:-shsahim/ultraviris-2026}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh (GitHub CLI) is not installed. Run: brew install gh && gh auth login" >&2
  exit 1
fi

echo "Creating issues in $REPO ..."

# Ensure the labels we use exist (ignore errors if they already do).
gh label create "deployment" --repo "$REPO" --color 0e8a16 --description "Go-live / infra setup" 2>/dev/null || true
gh label create "aws"        --repo "$REPO" --color ff9900 --description "AWS resource/config"    2>/dev/null || true
gh label create "todo"       --repo "$REPO" --color fbca04 --description "Outstanding task"        2>/dev/null || true

create() {
  local title="$1"; local labels="$2"; local body="$3"
  gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body"
}

create "Set up Amazon S3 for image storage" "deployment,aws,todo" \
"Local uploads in \`public/images/\` don't persist or shard across an autoscaled fleet, so production must use S3.

- [ ] Create an S3 bucket for artwork images.
- [ ] Decide public-access strategy: public bucket/CloudFront CDN, or private + signed URLs (current code expects publicly-readable URLs).
- [ ] Set \`S3_BUCKET\` (enables admin uploads via \`lib/storage.ts\`).
- [ ] Set \`IMAGE_BASE_URL\` to the bucket/CDN base so stored \`File_Location\` values resolve to S3 URLs.
- [ ] Grant the runtime IAM role \`s3:PutObject\` (+ \`s3:GetObject\` if private).
- [ ] Migrate existing \`public/images/**\` into the bucket, preserving relative paths.

Note: the local .jpg/.png extension-fallback in \`lib/data.ts\` only works for local files — see the DB extension-fix issue."

create "Configure Amazon SES (email) for production" "deployment,aws,todo" \
"- [ ] Verify the sender identity (domain or address); set \`SES_FROM_EMAIL\`.
- [ ] Request SES production access (move out of the sandbox) so the contact form and alerts can email arbitrary recipients.
- [ ] Set \`CONTACT_TO_EMAIL\` and \`ALERT_EMAIL\`.
- [ ] On EC2, prefer the instance role for \`ses:SendEmail\` and leave \`AWS_ACCESS_KEY_ID\`/\`AWS_SECRET_ACCESS_KEY\` unset."

create "Create the Amazon ECR repository" "deployment,aws,todo" \
"- [ ] Create the ECR repo (\`make ecr-create\` or console/IaC). Default name \`ultraviris\`.
- [ ] If renamed, update \`ECR_REPO\` in \`Makefile\`, \`.github/workflows/build-and-push.yml\`, and \`scripts/userdata.sh\`.
- [ ] Confirm \`AWS_REGION\` is consistent across Makefile, workflow, and userdata."

create "Wire GitHub Actions to AWS via OIDC" "deployment,aws,todo" \
"- [ ] Create an IAM OIDC identity provider for GitHub Actions.
- [ ] Create a deploy role trusted by this repo (scope trust to \`repo:shsahim/ultraviris-2026:*\`) with ECR push permissions.
- [ ] Add the repo secret \`AWS_ROLE_ARN\` with that role's ARN."

create "Provision EC2 / Auto Scaling Group + ALB" "deployment,aws,todo" \
"- [ ] Launch template using an ARM64/Graviton instance type (e.g. t4g/c7g) + Amazon Linux 2023, with \`scripts/userdata.sh\` as user-data (edit top-of-file config vars).
- [ ] Instance IAM role: \`ecr:GetAuthorizationToken\`, \`ecr:BatchGetImage\`, \`ecr:GetDownloadUrlForLayer\`, \`secretsmanager:GetSecretValue\` (both secrets), plus \`ses:SendEmail\` and scoped \`s3:*\` if using the role.
- [ ] Application Load Balancer with health check path \`/api/health/status\`; put the ASG behind it.
- [ ] Security groups: ALB → instances on the app port; instances must reach the SSH bastion (DB tunnel) and AWS APIs (SES/S3/ECR/Secrets Manager)."

create "Create AWS Secrets Manager secrets" "deployment,aws,todo" \
"\`scripts/userdata.sh\` expects two secrets:

- [ ] \`ultraviris/env\` — dotenv-formatted runtime environment (a filled-in \`.env.example\`, including \`HEALTH_CHECK_SECRET\`, DB/SSH, SES, S3, admin secrets).
- [ ] \`ultraviris/ssh-key\` — the SSH private key PEM for the DB tunnel (mounted read-only at \`/run/ssh_key.pem\`).
- [ ] If renamed, update \`ENV_SECRET\`/\`SSH_KEY_SECRET\` in \`scripts/userdata.sh\`."

create "Schedule production health checks + uptime monitor" "deployment,todo" \
"- [ ] Keep the per-instance host cron from \`userdata.sh\`, OR (preferred for a large ASG) create a single EventBridge Scheduler that POSTs to \`https://<domain>/api/health/cron\` with \`HEALTH_CHECK_SECRET\`.
- [ ] Point an external uptime monitor at \`/api/health/status\`."

create "Domain, TLS, and production secrets hygiene" "deployment,todo" \
"- [ ] Route 53 domain → ALB; ACM TLS cert + HTTPS listener.
- [ ] Generate strong production \`ADMIN_PASSWORD\`, \`ADMIN_SESSION_SECRET\`, and \`HEALTH_CHECK_SECRET\` (do not reuse dev values).
- [ ] Confirm \`.env.local\` and \`*.pem\` are never committed (already gitignored)."

create "Fix File_Location extensions in the database" "todo" \
"Some \`File_Location\` values end in \`.png\` while the real files are \`.jpg\`. The gallery compensates locally, but S3 won't.

- [ ] Run a one-time script to correct \`File_Location\` extensions to match the actual objects before/at the S3 migration."

create "Housekeeping: Node 22 + observability" "todo" \
"- [ ] Bump local dev Node to 22 LTS (CI and Docker already use 22; AWS SDK warns on Node 21).
- [ ] Add log shipping/metrics (CloudWatch agent) for dashboards beyond the in-app Site Health page."

echo "Done."
