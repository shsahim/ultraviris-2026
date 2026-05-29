#!/bin/bash
#
# Provisions AWS resources for ultraviris (issues #1–4, #6–8, plus IAM prep for EC2).
# Does NOT provision EC2 / Auto Scaling Group / ALB (issue #5).
#
# Prerequisites:
#   - AWS CLI v2 installed and configured (IAM user access key or aws configure)
#   - jq installed (brew install jq)
#   - Copy scripts/aws-setup.config.example → scripts/aws-setup.config and edit
#
# IAM user: attach a policy that allows (scoped to your account/region where possible):
#   sts:GetCallerIdentity
#   ecr:CreateRepository, ecr:DescribeRepositories
#   s3:CreateBucket, s3:PutBucketPolicy, s3:PutPublicAccessBlock, s3:PutBucketCors,
#       s3:HeadBucket, s3:ListBucket, s3:PutObject (for sync)
#   ses:VerifyEmailIdentity, ses:GetIdentityVerificationAttributes
#   iam:CreateOpenIDConnectProvider, iam:GetOpenIDConnectProvider,
#       iam:CreateRole, iam:GetRole, iam:UpdateAssumeRolePolicy, iam:PutRolePolicy,
#       iam:CreateInstanceProfile, iam:GetInstanceProfile, iam:AddRoleToInstanceProfile,
#       iam:AttachRolePolicy
#   secretsmanager:CreateSecret, secretsmanager:PutSecretValue, secretsmanager:DescribeSecret
#   lambda:CreateFunction, lambda:UpdateFunctionCode, lambda:UpdateFunctionConfiguration,
#       lambda:GetFunction, lambda:AddPermission
#   events:PutRule, events:PutTargets
#   acm:RequestCertificate, acm:DescribeCertificate
#   route53:ChangeResourceRecordSets (only if using HOSTED_ZONE_ID)
#
# Usage:
#   ./scripts/setup-aws.sh
#   ./scripts/setup-aws.sh --config /path/to/aws-setup.config
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/aws-setup.config"
OUTPUT_FILE="${SCRIPT_DIR}/aws-setup-outputs.env"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '1,20p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { echo "== $*"; }
warn() { echo "!! $*" >&2; }
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

aws_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] aws $*" >&2
    return 0
  fi
  aws "$@"
}

rand_hex() {
  openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64
}

dotenv_set() {
  # dotenv_set FILE KEY VALUE — upsert KEY=VALUE in a dotenv file
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    if [[ "$(uname)" == Darwin ]]; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
    else
      sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    fi
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

dotenv_get() {
  local file="$1" key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true
}

# ── Load config ───────────────────────────────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
else
  warn "No $CONFIG_FILE — using defaults and environment variables only."
fi

AWS_REGION="${AWS_REGION:-us-west-2}"
GITHUB_OWNER="${GITHUB_OWNER:-shsahim}"
GITHUB_REPO="${GITHUB_REPO:-ultraviris-2026}"
ECR_REPO="${ECR_REPO:-ultraviris}"
NAME_PREFIX="${NAME_PREFIX:-ultraviris}"
ENV_SOURCE_FILE="${ENV_SOURCE_FILE:-.env.local}"
CONTACT_TO_EMAIL="${CONTACT_TO_EMAIL:-ultraviris@gmail.com}"
SYNC_LOCAL_IMAGES="${SYNC_LOCAL_IMAGES:-1}"

require_cmd aws
require_cmd jq
require_cmd openssl

export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_REGION

log "Verifying AWS credentials"
if [[ "$DRY_RUN" -eq 0 ]]; then
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
else
  ACCOUNT_ID="000000000000"
  CALLER_ARN="dry-run"
fi
log "Account: $ACCOUNT_ID  Caller: $CALLER_ARN"

# ── Issue #3: ECR ─────────────────────────────────────────────────────────────
setup_ecr() {
  log "ECR repository: $ECR_REPO"
  if aws_cmd ecr describe-repositories --repository-names "$ECR_REPO" >/dev/null 2>&1; then
    warn "ECR repo $ECR_REPO already exists"
  else
    aws_cmd ecr create-repository \
      --repository-name "$ECR_REPO" \
      --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256
  fi
  ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
  ECR_IMAGE_URI="${ECR_REGISTRY}/${ECR_REPO}"
}

# ── Issue #1: S3 ──────────────────────────────────────────────────────────────
setup_s3() {
  if [[ -z "${S3_BUCKET:-}" ]]; then
    S3_BUCKET="${NAME_PREFIX}-images-${ACCOUNT_ID}"
  fi
  log "S3 bucket: $S3_BUCKET"

  if aws_cmd s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
    warn "Bucket $S3_BUCKET already exists"
  else
    if [[ "$AWS_REGION" == "us-east-1" ]]; then
      aws_cmd s3api create-bucket --bucket "$S3_BUCKET"
    else
      aws_cmd s3api create-bucket --bucket "$S3_BUCKET" \
        --create-bucket-configuration "LocationConstraint=${AWS_REGION}"
    fi
  fi

  # Public read for gallery objects (matches current app expecting public URLs).
  aws_cmd s3api put-public-access-block --bucket "$S3_BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

  POLICY="$(jq -n --arg bucket "$S3_BUCKET" '{
    Version: "2012-10-17",
    Statement: [{
      Sid: "PublicReadGetObject",
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: ("arn:aws:s3:::" + $bucket + "/*")
    }]
  }')"
  aws_cmd s3api put-bucket-policy --bucket "$S3_BUCKET" --policy "$POLICY"

  aws_cmd s3api put-bucket-cors --bucket "$S3_BUCKET" --cors-configuration '{
    "CORSRules": [{
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedOrigins": ["*"],
      "MaxAgeSeconds": 3600
    }]
  }'

  IMAGE_BASE_URL="https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com"

  if [[ "$SYNC_LOCAL_IMAGES" == "1" && -d "$REPO_ROOT/public/images" ]]; then
    log "Syncing public/images → s3://$S3_BUCKET/images/"
    run aws s3 sync "$REPO_ROOT/public/images" "s3://${S3_BUCKET}/images/" \
      --exclude ".DS_Store" --exclude "_notes/*" --exclude "**/_notes/*"
  fi
}

# ── Issue #2: SES ─────────────────────────────────────────────────────────────
setup_ses() {
  if [[ -z "${SES_FROM_EMAIL:-}" ]]; then
    warn "SES_FROM_EMAIL not set — skipping SES verification (set in aws-setup.config)"
    return
  fi
  log "SES: verifying $SES_FROM_EMAIL"
  aws_cmd ses verify-email-identity --email-address "$SES_FROM_EMAIL" 2>/dev/null || true

  if [[ -n "${ALERT_EMAIL:-}" && "$ALERT_EMAIL" != "$SES_FROM_EMAIL" ]]; then
    log "SES: verifying alert recipient $ALERT_EMAIL (needed while account is in sandbox)"
    aws_cmd ses verify-email-identity --email-address "$ALERT_EMAIL" 2>/dev/null || true
  fi

  if [[ "$CONTACT_TO_EMAIL" != "$SES_FROM_EMAIL" ]]; then
    log "SES: verifying contact recipient $CONTACT_TO_EMAIL (sandbox)"
    aws_cmd ses verify-email-identity --email-address "$CONTACT_TO_EMAIL" 2>/dev/null || true
  fi

  warn "Check inboxes and click SES verification links."
  warn "Request SES production access in the console to email arbitrary recipients (manual step)."
}

# ── Issue #4: GitHub OIDC + deploy role ─────────────────────────────────────
setup_github_oidc() {
  local provider_url="https://token.actions.githubusercontent.com"
  local aud="sts.amazonaws.com"
  local thumbprint="6938fd4d98bab03faadb97b34396831e3780aea1"
  local oidc_arn="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
  local role_name="${NAME_PREFIX}-github-actions"
  GITHUB_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${role_name}"

  log "GitHub OIDC provider"
  if ! aws_cmd iam get-open-id-connect-provider --open-id-connect-provider-arn "$oidc_arn" >/dev/null 2>&1; then
    aws_cmd iam create-open-id-connect-provider \
      --url "$provider_url" \
      --client-id-list "$aud" \
      --thumbprint-list "$thumbprint"
  else
    warn "OIDC provider already exists"
  fi

  TRUST="$(jq -n \
    --arg oidc "$oidc_arn" \
    --arg owner "$GITHUB_OWNER" \
    --arg repo "$GITHUB_REPO" \
    '{
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Federated: $oidc },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
          StringLike: { "token.actions.githubusercontent.com:sub": ("repo:" + $owner + "/" + $repo + ":*") }
        }
      }]
    }')"

  if aws_cmd iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    warn "IAM role $role_name already exists — updating trust policy"
    aws_cmd iam update-assume-role-policy --role-name "$role_name" --policy-document "$TRUST"
  else
    aws_cmd iam create-role --role-name "$role_name" --assume-role-policy-document "$TRUST"
  fi

  ECR_POLICY="$(jq -n \
    --arg acct "$ACCOUNT_ID" \
    --arg region "$AWS_REGION" \
    --arg repo "$ECR_REPO" \
    '{
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["ecr:GetAuthorizationToken"],
          Resource: "*"
        },
        {
          Effect: "Allow",
          Action: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:PutImage",
            "ecr:InitiateLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload"
          ],
          Resource: ("arn:aws:ecr:" + $region + ":" + $acct + ":repository/" + $repo)
        }
      ]
    }')"

  aws_cmd iam put-role-policy \
    --role-name "$role_name" \
    --policy-name "${NAME_PREFIX}-ecr-push" \
    --policy-document "$ECR_POLICY"

  log "Add GitHub repo secret AWS_ROLE_ARN=$GITHUB_ROLE_ARN"
}

# ── IAM for EC2 instances (prep for issue #5 — role only, no instances) ───────
setup_ec2_iam() {
  local role_name="${NAME_PREFIX}-ec2"
  local profile_name="${NAME_PREFIX}-ec2"
  EC2_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${role_name}"

  TRUST='{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

  log "EC2 instance IAM role: $role_name"
  if ! aws_cmd iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    aws_cmd iam create-role --role-name "$role_name" --assume-role-policy-document "$TRUST"
  fi

  POLICY="$(jq -n \
    --arg acct "$ACCOUNT_ID" \
    --arg region "$AWS_REGION" \
    --arg repo "$ECR_REPO" \
    --arg bucket "${S3_BUCKET:-*}" \
    --arg prefix "$NAME_PREFIX" \
    '{
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["ecr:GetAuthorizationToken"],
          Resource: "*"
        },
        {
          Effect: "Allow",
          Action: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage"
          ],
          Resource: ("arn:aws:ecr:" + $region + ":" + $acct + ":repository/" + $repo)
        },
        {
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue"],
          Resource: [
            ("arn:aws:secretsmanager:" + $region + ":" + $acct + ":secret:" + $prefix + "/env*"),
            ("arn:aws:secretsmanager:" + $region + ":" + $acct + ":secret:" + $prefix + "/ssh-key*")
          ]
        },
        {
          Effect: "Allow",
          Action: ["ses:SendEmail", "ses:SendRawEmail"],
          Resource: "*"
        },
        {
          Effect: "Allow",
          Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
          Resource: [
            ("arn:aws:s3:::" + $bucket),
            ("arn:aws:s3:::" + $bucket + "/*")
          ]
        }
      ]
    }')"

  aws_cmd iam put-role-policy \
    --role-name "$role_name" \
    --policy-name "${NAME_PREFIX}-ec2-app" \
    --policy-document "$POLICY"

  if ! aws_cmd iam get-instance-profile --instance-profile-name "$profile_name" >/dev/null 2>&1; then
    aws_cmd iam create-instance-profile --instance-profile-name "$profile_name"
  fi

  # Ensure role is attached to the profile (idempotent add)
  if [[ "$DRY_RUN" -eq 0 ]]; then
    if ! aws iam get-instance-profile --instance-profile-name "$profile_name" \
      | jq -e --arg r "$role_name" '.InstanceProfile.Roles[] | select(.RoleName == $r)' >/dev/null; then
      aws iam add-role-to-instance-profile \
        --instance-profile-name "$profile_name" \
        --role-name "$role_name"
    fi
  fi

  EC2_INSTANCE_PROFILE_ARN="arn:aws:iam::${ACCOUNT_ID}:instance-profile/${profile_name}"
  log "Attach instance profile to launch template / EC2: $profile_name"
}

# ── Issue #6: Secrets Manager ─────────────────────────────────────────────────
setup_secrets() {
  local env_secret="${NAME_PREFIX}/env"
  local key_secret="${NAME_PREFIX}/ssh-key"
  local build_env
  build_env="$(mktemp)"

  log "Building secret $env_secret"
  if [[ -f "$REPO_ROOT/$ENV_SOURCE_FILE" ]]; then
    cp "$REPO_ROOT/$ENV_SOURCE_FILE" "$build_env"
  elif [[ -f "$REPO_ROOT/.env.example" ]]; then
    cp "$REPO_ROOT/.env.example" "$build_env"
    warn "Using .env.example — fill in DB/SSH values in Secrets Manager or re-run after editing $ENV_SOURCE_FILE"
  else
    echo "# ultraviris runtime env" >"$build_env"
  fi

  # Production on EC2 should use the instance role, not static keys.
  sed -i.bak '/^AWS_ACCESS_KEY_ID=/d;/^AWS_SECRET_ACCESS_KEY=/d' "$build_env" 2>/dev/null || \
    sed -i '' '/^AWS_ACCESS_KEY_ID=/d;/^AWS_SECRET_ACCESS_KEY=/d' "$build_env"
  rm -f "${build_env}.bak"

  dotenv_set "$build_env" "AWS_REGION" "$AWS_REGION"
  [[ -n "${S3_BUCKET:-}" ]] && dotenv_set "$build_env" "S3_BUCKET" "$S3_BUCKET"
  [[ -n "${IMAGE_BASE_URL:-}" ]] && dotenv_set "$build_env" "IMAGE_BASE_URL" "$IMAGE_BASE_URL"
  [[ -n "${SES_FROM_EMAIL:-}" ]] && dotenv_set "$build_env" "SES_FROM_EMAIL" "$SES_FROM_EMAIL"
  dotenv_set "$build_env" "CONTACT_TO_EMAIL" "$CONTACT_TO_EMAIL"
  [[ -n "${ALERT_EMAIL:-}" ]] && dotenv_set "$build_env" "ALERT_EMAIL" "${ALERT_EMAIL:-$CONTACT_TO_EMAIL}"

  if [[ -z "$(dotenv_get "$build_env" HEALTH_CHECK_SECRET)" ]]; then
    HEALTH_CHECK_SECRET="$(rand_hex)"
    dotenv_set "$build_env" "HEALTH_CHECK_SECRET" "$HEALTH_CHECK_SECRET"
    log "Generated HEALTH_CHECK_SECRET"
  else
    HEALTH_CHECK_SECRET="$(dotenv_get "$build_env" HEALTH_CHECK_SECRET)"
  fi
  export HEALTH_CHECK_SECRET

  if [[ -z "$(dotenv_get "$build_env" ADMIN_SESSION_SECRET)" ]]; then
    dotenv_set "$build_env" "ADMIN_SESSION_SECRET" "$(rand_hex)"
    log "Generated ADMIN_SESSION_SECRET"
  fi

  if [[ -z "$(dotenv_get "$build_env" ADMIN_PASSWORD)" ]]; then
    warn "ADMIN_PASSWORD is empty in env secret — set it before go-live"
  fi

  if aws_cmd secretsmanager describe-secret --secret-id "$env_secret" >/dev/null 2>&1; then
    aws_cmd secretsmanager put-secret-value \
      --secret-id "$env_secret" \
      --secret-string "file://$build_env"
  else
    aws_cmd secretsmanager create-secret \
      --name "$env_secret" \
      --description "ultraviris application environment (dotenv)" \
      --secret-string "file://$build_env"
  fi
  rm -f "$build_env"

  if [[ -z "${SSH_KEY_FILE:-}" ]]; then
    warn "SSH_KEY_FILE not set — skipping $key_secret (required for DB tunnel on EC2)"
    return
  fi
  local key_path="${SSH_KEY_FILE/#\~/$HOME}"
  if [[ ! -f "$key_path" ]]; then
    echo "SSH key not found: $key_path" >&2
    exit 1
  fi
  log "Storing SSH key in $key_secret"
  if aws_cmd secretsmanager describe-secret --secret-id "$key_secret" >/dev/null 2>&1; then
    aws_cmd secretsmanager put-secret-value \
      --secret-id "$key_secret" \
      --secret-string "file://$key_path"
  else
    aws_cmd secretsmanager create-secret \
      --name "$key_secret" \
      --description "SSH private key for MySQL tunnel" \
      --secret-string "file://$key_path"
  fi

  # userdata.sh defaults — document alignment
  warn "userdata.sh expects ENV_SECRET=${env_secret} and SSH_KEY_SECRET=${key_secret}"
}

# ── Issue #7: EventBridge → Lambda → health cron URL ────────────────────────
setup_health_scheduler() {
  if [[ "${SKIP_HEALTH_SCHEDULER:-0}" == "1" ]]; then
    warn "Skipping health scheduler (SKIP_HEALTH_SCHEDULER=1)"
    return
  fi
  if [[ -z "${HEALTH_CRON_URL:-}" ]]; then
    warn "HEALTH_CRON_URL not set — skipping EventBridge/Lambda (set after ALB/domain exists)"
    return
  fi
  if [[ -z "${HEALTH_CHECK_SECRET:-}" ]]; then
    echo "HEALTH_CHECK_SECRET must be set (run secrets step first or set in config env)" >&2
    exit 1
  fi

  local fn_name="${NAME_PREFIX}-health-cron"
  local rule_name="${NAME_PREFIX}-health-cron-5m"
  local role_name="${NAME_PREFIX}-lambda-health"
  local zip_path
  zip_path="$(mktemp /tmp/health-cron.XXXXXX.zip)"

  log "Lambda + EventBridge for health cron: $HEALTH_CRON_URL"

  LAMBDA_TRUST='{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'
  if ! aws_cmd iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    aws_cmd iam create-role --role-name "$role_name" --assume-role-policy-document "$LAMBDA_TRUST"
    aws_cmd iam attach-role-policy --role-name "$role_name" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    sleep 10
  fi
  local lambda_role_arn="arn:aws:iam::${ACCOUNT_ID}:role/${role_name}"

  mkdir -p /tmp/health-cron-pkg
  cat >/tmp/health-cron-pkg/lambda_function.py <<'PY'
import os
import urllib.request

def handler(event, context):
    url = os.environ["HEALTH_CRON_URL"]
    secret = os.environ["HEALTH_CHECK_SECRET"]
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {secret}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8", errors="replace")[:500]
        print(resp.status, body)
    return {"ok": True}
PY
  (cd /tmp/health-cron-pkg && zip -q "$zip_path" lambda_function.py)

  if aws_cmd lambda get-function --function-name "$fn_name" >/dev/null 2>&1; then
    aws_cmd lambda update-function-code --function-name "$fn_name" --zip-file "fileb://$zip_path"
    aws_cmd lambda update-function-configuration \
      --function-name "$fn_name" \
      --environment "Variables={HEALTH_CRON_URL=${HEALTH_CRON_URL},HEALTH_CHECK_SECRET=${HEALTH_CHECK_SECRET}}"
  else
    aws_cmd lambda create-function \
      --function-name "$fn_name" \
      --runtime python3.12 \
      --role "$lambda_role_arn" \
      --handler lambda_function.handler \
      --zip-file "fileb://$zip_path" \
      --timeout 60 \
      --environment "Variables={HEALTH_CRON_URL=${HEALTH_CRON_URL},HEALTH_CHECK_SECRET=${HEALTH_CHECK_SECRET}}"
  fi
  rm -f "$zip_path"

  local fn_arn="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${fn_name}"

  aws_cmd events put-rule \
    --name "$rule_name" \
    --schedule-expression "rate(5 minutes)" \
    --state ENABLED

  aws_cmd events put-targets \
    --rule "$rule_name" \
    --targets "Id"="1","Arn"="$fn_arn"

  if [[ "$DRY_RUN" -eq 0 ]]; then
    aws lambda add-permission \
      --function-name "$fn_name" \
      --statement-id "${rule_name}-invoke" \
      --action lambda:InvokeFunction \
      --principal events.amazonaws.com \
      --source-arn "arn:aws:events:${AWS_REGION}:${ACCOUNT_ID}:rule/${rule_name}" \
      2>/dev/null || true
  fi
}

# ── Issue #8: ACM (+ optional Route 53 validation records) ────────────────────
setup_acm() {
  if [[ "${SKIP_ACM:-0}" == "1" ]]; then
    warn "Skipping ACM (SKIP_ACM=1)"
    return
  fi
  if [[ -z "${DOMAIN_NAME:-}" ]]; then
    warn "DOMAIN_NAME not set — skipping ACM"
    return
  fi

  log "ACM certificate for $DOMAIN_NAME"
  local cert_arn
  cert_arn="$(aws_cmd acm request-certificate \
    --domain-name "$DOMAIN_NAME" \
    --subject-alternative-names "*.${DOMAIN_NAME}" \
    --validation-method DNS \
    --query CertificateArn --output text)"

  ACM_CERT_ARN="$cert_arn"
  warn "Waiting for ACM to publish DNS validation records..."
  sleep 15

  if [[ -z "${HOSTED_ZONE_ID:-}" ]]; then
    warn "HOSTED_ZONE_ID not set — add ACM DNS validation records manually in Route 53"
    aws_cmd acm describe-certificate --certificate-arn "$cert_arn" \
      --query 'Certificate.DomainValidationOptions' --output table || true
    return
  fi

  local records
  records="$(aws acm describe-certificate --certificate-arn "$cert_arn" \
    --query 'Certificate.DomainValidationOptions[?ResourceRecord!=null].ResourceRecord' --output json)"

  echo "$records" | jq -c '.[]' | while read -r rr; do
    local name value
    name="$(echo "$rr" | jq -r .Name)"
    value="$(echo "$rr" | jq -r .Value)"
    CHANGE="$(jq -n --arg name "$name" --arg value "$value" '{
      Changes: [{
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: $name,
          Type: "CNAME",
          TTL: 300,
          ResourceRecords: [{ Value: $value }]
        }
      }]
    }')"
    log "Route 53 validation record: $name"
    aws_cmd route53 change-resource-record-sets \
      --hosted-zone-id "$HOSTED_ZONE_ID" \
      --change-batch "$CHANGE"
  done

  warn "ACM validation may take several minutes. Use cert ARN on the ALB HTTPS listener (issue #5)."
}

# ── Write outputs ─────────────────────────────────────────────────────────────
write_outputs() {
  log "Writing $OUTPUT_FILE"
  cat >"$OUTPUT_FILE" <<EOF
# Generated by scripts/setup-aws.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
AWS_REGION=$AWS_REGION
AWS_ACCOUNT_ID=$ACCOUNT_ID
ECR_REGISTRY=${ECR_REGISTRY:-}
ECR_IMAGE_URI=${ECR_IMAGE_URI:-}
S3_BUCKET=${S3_BUCKET:-}
IMAGE_BASE_URL=${IMAGE_BASE_URL:-}
GITHUB_ROLE_ARN=${GITHUB_ROLE_ARN:-}
EC2_ROLE_ARN=${EC2_ROLE_ARN:-}
EC2_INSTANCE_PROFILE_ARN=${EC2_INSTANCE_PROFILE_ARN:-}
ACM_CERT_ARN=${ACM_CERT_ARN:-}
# GitHub repo secret:
#   AWS_ROLE_ARN=${GITHUB_ROLE_ARN:-}
EOF
  cat "$OUTPUT_FILE"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  cd "$REPO_ROOT"
  setup_ecr
  setup_s3
  setup_ses
  setup_github_oidc
  setup_ec2_iam
  setup_secrets
  # HEALTH_CHECK_SECRET set in setup_secrets
  setup_health_scheduler
  setup_acm
  write_outputs

  echo ""
  log "AWS setup complete (EC2/ASG/ALB not created — issue #5)"
  echo "Manual follow-ups:"
  echo "  • Click SES verification links; request production access"
  echo "  • Set ADMIN_PASSWORD in Secrets Manager secret ${NAME_PREFIX}/env if empty"
  echo "  • GitHub secret AWS_ROLE_ARN → see $OUTPUT_FILE"
  echo "  • Provision EC2/ASG/ALB (issue #5) using instance profile ${NAME_PREFIX}-ec2"
  echo "  • Set HEALTH_CRON_URL and re-run, or use userdata host cron until ALB exists"
  echo "  • Issue #9: run scripts/fix-file-locations.mts before relying on S3-only images"
}

main
