#!/bin/bash
#
# Cross-account Route 53 helper. The hosted zone for DOMAIN_NAME lives in a
# different AWS account (DNS_ACCOUNT_ID), so this manages the two records the
# ALB/HTTPS setup needs by assuming a role in that account:
#   1) the ACM DNS-validation CNAME (so the cert can be issued)
#   2) the apex A/ALIAS pointing DOMAIN_NAME at the ALB
#
# Two modes:
#   create-role   Run with DNS-account credentials (e.g. AWS_PROFILE=network) ONCE.
#                 Creates an IAM role the app account can assume to edit the zone.
#   apply         (default) Run with app-account credentials. Assumes that role,
#                 reads the ACM cert + ALB from the app account, and upserts the
#                 record(s). Idempotent — run it again after the ALB exists to add
#                 the apex alias.
#
# Usage:
#   AWS_PROFILE=network ./scripts/setup-dns.sh create-role
#   ./scripts/setup-dns.sh                 # apply (assumes the role)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUTS="${SCRIPT_DIR}/aws-setup-outputs.env"
CONFIG="${SCRIPT_DIR}/aws-setup.config"

[ -f "$CONFIG" ]  && { set -a; . "$CONFIG"; set +a; }
[ -f "$OUTPUTS" ] && { set -a; . "$OUTPUTS"; set +a; }

AWS_REGION="${AWS_REGION:-us-west-2}"
NAME_PREFIX="${NAME_PREFIX:-ultraviris}"
DOMAIN_NAME="${DOMAIN_NAME:-nataliernathan.com}"
DNS_ACCOUNT_ID="${DNS_ACCOUNT_ID:-116851791213}"
DNS_ROLE_NAME="${DNS_ROLE_NAME:-${NAME_PREFIX}-dns-manager}"
DNS_ROLE_ARN="${DNS_ROLE_ARN:-arn:aws:iam::${DNS_ACCOUNT_ID}:role/${DNS_ROLE_NAME}}"
# Optional shared secret that the app account must pass when assuming the role.
ROLE_EXTERNAL_ID="${ROLE_EXTERNAL_ID:-}"
# Optional: an AWS CLI profile with DIRECT write access to the DNS account's zone.
# When set, `apply` writes Route 53 records using this profile instead of doing a
# cross-account sts:AssumeRole — simpler when you already have DNS-account creds.
DNS_PROFILE="${DNS_PROFILE:-}"
# App account id (the account allowed to assume the role); from setup outputs.
APP_ACCOUNT_ID="${APP_ACCOUNT_ID:-${AWS_ACCOUNT_ID:-}}"

command -v aws >/dev/null || { echo "aws CLI v2 is required" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq is required" >&2; exit 1; }

log()  { echo "== $*"; }
warn() { echo "!! $*" >&2; }

# ── create-role: run in the DNS account ───────────────────────────────────────
create_role() {
  local me
  me="$(aws sts get-caller-identity --query Account --output text)"
  if [ "$me" != "$DNS_ACCOUNT_ID" ]; then
    warn "Current credentials are for account $me, not the DNS account $DNS_ACCOUNT_ID."
    warn "Run this with DNS-account credentials, e.g.: AWS_PROFILE=network $0 create-role"
    exit 1
  fi
  if [ -z "$APP_ACCOUNT_ID" ]; then
    warn "APP_ACCOUNT_ID unknown. Set it (the account that runs the pipeline/setup) and retry."
    exit 1
  fi

  log "Creating role $DNS_ROLE_NAME in $DNS_ACCOUNT_ID, trusting app account $APP_ACCOUNT_ID"
  local cond=""
  if [ -n "$ROLE_EXTERNAL_ID" ]; then
    cond="$(jq -n --arg x "$ROLE_EXTERNAL_ID" '{StringEquals: {"sts:ExternalId": $x}}')"
  else
    cond="{}"
  fi
  local trust
  trust="$(jq -n --arg app "$APP_ACCOUNT_ID" --argjson cond "$cond" '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: ("arn:aws:iam::" + $app + ":root") },
      Action: "sts:AssumeRole"
    } + (if ($cond | length) > 0 then {Condition: $cond} else {} end)]
  }')"

  if aws iam get-role --role-name "$DNS_ROLE_NAME" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$DNS_ROLE_NAME" --policy-document "$trust"
  else
    aws iam create-role --role-name "$DNS_ROLE_NAME" --assume-role-policy-document "$trust" \
      --description "Lets the ultraviris app account manage Route 53 records for ${DOMAIN_NAME}"
  fi

  # Scope record writes to hosted zones in this account; list/get can't be scoped.
  local perms
  perms="$(jq -n '{
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"],
        Resource: "arn:aws:route53:::hostedzone/*"
      },
      {
        Effect: "Allow",
        Action: ["route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:GetChange"],
        Resource: "*"
      }
    ]
  }')"
  aws iam put-role-policy --role-name "$DNS_ROLE_NAME" \
    --policy-name "${NAME_PREFIX}-route53" --policy-document "$perms"

  echo ""
  log "Role ready: $DNS_ROLE_ARN"
  [ -n "$ROLE_EXTERNAL_ID" ] && log "External ID required to assume: $ROLE_EXTERNAL_ID"
  log "Now run (with app-account creds):  ./scripts/setup-dns.sh"
}

# ── apply: run in the app account; assume the DNS role and upsert records ──────
apply() {
  # Route 53 (zone) calls run via r53(); ACM/ELB reads always use the default
  # (app-account) creds. Two ways to reach the zone:
  #   - DNS_PROFILE set: write directly with that DNS-account profile.
  #   - otherwise: cross-account sts:AssumeRole into DNS_ROLE_ARN.
  if [ -n "$DNS_PROFILE" ]; then
    log "Using profile '$DNS_PROFILE' to manage $DOMAIN_NAME directly"
    r53() { aws --profile "$DNS_PROFILE" "$@"; }
  else
    log "Assuming $DNS_ROLE_ARN to manage $DOMAIN_NAME"
    local extra=()
    [ -n "$ROLE_EXTERNAL_ID" ] && extra=(--external-id "$ROLE_EXTERNAL_ID")
    # Assume-role can fail transiently right after the trust/identity policies are
    # created (IAM is eventually consistent), so retry with backoff.
    local creds="" attempts="${ASSUME_RETRIES:-8}" i delay=5
    for ((i = 1; i <= attempts; i++)); do
      if creds="$(aws sts assume-role --role-arn "$DNS_ROLE_ARN" \
        --role-session-name "ultraviris-dns" "${extra[@]+"${extra[@]}"}" \
        --query 'Credentials' --output json 2>/dev/null)"; then
        break
      fi
      if [ "$i" -eq "$attempts" ]; then
        warn "Could not assume $DNS_ROLE_ARN after $attempts attempts."
        warn "Check that the role's trust policy allows $APP_ACCOUNT_ID and that the"
        warn "calling identity has sts:AssumeRole on this role ARN."
        warn "(Alternatively set DNS_PROFILE=<dns-account-profile> to write directly.)"
        # One more time without silencing, so the real AWS error is shown.
        aws sts assume-role --role-arn "$DNS_ROLE_ARN" \
          --role-session-name "ultraviris-dns" "${extra[@]+"${extra[@]}"}" \
          --query 'Credentials' --output json
        exit 1
      fi
      warn "assume-role failed (attempt $i/$attempts); retrying in ${delay}s..."
      sleep "$delay"
      [ "$delay" -lt 30 ] && delay=$((delay * 2))
    done
    local AK SK ST
    AK="$(echo "$creds" | jq -r .AccessKeyId)"
    SK="$(echo "$creds" | jq -r .SecretAccessKey)"
    ST="$(echo "$creds" | jq -r .SessionToken)"
    r53() { AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" aws "$@"; }
  fi

  # Hosted zone id (override with HOSTED_ZONE_ID to skip discovery).
  local zone_id="${HOSTED_ZONE_ID:-}"
  if [ -z "$zone_id" ]; then
    zone_id="$(r53 route53 list-hosted-zones-by-name --dns-name "${DOMAIN_NAME}." \
      --query "HostedZones[?Name=='${DOMAIN_NAME}.'].Id | [0]" --output text)"
    zone_id="${zone_id#/hostedzone/}"
  fi
  if [ -z "$zone_id" ] || [ "$zone_id" = "None" ]; then
    warn "No hosted zone found for ${DOMAIN_NAME} in account ${DNS_ACCOUNT_ID}."
    exit 1
  fi
  log "Hosted zone: $zone_id"

  local changes="[]"
  add_change() { changes="$(echo "$changes" | jq --argjson c "$1" '. + [$c]')"; }

  # 1) ACM DNS-validation CNAME (from the app account's ACM cert).
  local cert_arn rr
  cert_arn="$(aws acm list-certificates --region "$AWS_REGION" \
    --query "CertificateSummaryList[?DomainName=='${DOMAIN_NAME}'].CertificateArn | [0]" \
    --output text 2>/dev/null || echo None)"
  if [ -n "$cert_arn" ] && [ "$cert_arn" != "None" ]; then
    rr="$(aws acm describe-certificate --certificate-arn "$cert_arn" --region "$AWS_REGION" \
      --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json)"
    if [ "$rr" != "null" ] && [ -n "$rr" ]; then
      local n v
      n="$(echo "$rr" | jq -r .Name)"; v="$(echo "$rr" | jq -r .Value)"
      add_change "$(jq -n --arg n "$n" --arg v "$v" \
        '{Action:"UPSERT",ResourceRecordSet:{Name:$n,Type:"CNAME",TTL:300,ResourceRecords:[{Value:$v}]}}')"
      log "Validation CNAME: $n"
    fi
  else
    warn "No ACM cert for ${DOMAIN_NAME} yet — run 'make setup-alb-asg' first (it requests the cert)."
  fi

  # 2) Apex A/ALIAS → ALB (only once the ALB exists).
  local alb
  alb="$(aws elbv2 describe-load-balancers --names "${NAME_PREFIX}-alb" --region "$AWS_REGION" \
    --query 'LoadBalancers[0].[DNSName,CanonicalHostedZoneId]' --output text 2>/dev/null || echo "")"
  if [ -n "$alb" ] && [ "$alb" != "None	None" ]; then
    local alb_dns alb_zone
    alb_dns="$(echo "$alb" | awk '{print $1}')"
    alb_zone="$(echo "$alb" | awk '{print $2}')"
    add_change "$(jq -n --arg n "$DOMAIN_NAME" --arg d "$alb_dns" --arg z "$alb_zone" \
      '{Action:"UPSERT",ResourceRecordSet:{Name:$n,Type:"A",AliasTarget:{DNSName:$d,HostedZoneId:$z,EvaluateTargetHealth:false}}}')"
    log "Apex alias: $DOMAIN_NAME → $alb_dns"
  else
    warn "ALB ${NAME_PREFIX}-alb not found yet — skipping apex alias (re-run after 'make setup-alb-asg')."
  fi

  if [ "$changes" = "[]" ]; then
    warn "Nothing to do."
    exit 0
  fi

  local batch change_id
  batch="$(jq -n --argjson ch "$changes" '{Changes: $ch}')"
  change_id="$(r53 route53 change-resource-record-sets \
    --hosted-zone-id "$zone_id" --change-batch "$batch" \
    --query 'ChangeInfo.Id' --output text)"
  log "Submitted change $change_id — waiting for INSYNC..."
  r53 route53 wait resource-record-sets-changed --id "$change_id"
  log "Done. DNS records are in sync."
}

case "${1:-apply}" in
  create-role) create_role ;;
  apply)       apply ;;
  *) echo "Usage: $0 [create-role|apply]" >&2; exit 1 ;;
esac
