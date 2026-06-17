#!/bin/bash
#
# Provisions an internet-facing Application Load Balancer + Auto Scaling Group
# for ultraviris, with HTTPS terminated at the ALB using an ACM certificate for
# DOMAIN_NAME (default: nataliernathan.com).
#
#   Internet ──443──> ALB (ACM cert) ──80──> ASG instances :80 ──> container :3000
#               80 ──> ALB (redirect to 443)
#
# Instances run scripts/userdata.sh (Docker + pull from ECR), are tagged
# App=ultraviris so the SSM deploy pipeline targets them, and only accept traffic
# from the ALB security group.
#
# DNS for the domain lives in a DIFFERENT AWS account, so this script cannot
# create Route 53 records directly. It prints the exact records to add there:
#   1) the ACM DNS-validation CNAME (needed before the cert is issued)
#   2) an apex A/ALIAS record pointing nataliernathan.com at the ALB
#
# Prereqs: run scripts/setup-aws.sh first (ECR, S3, secrets, instance profile,
# uploaded deploy.sh). Idempotent + re-runnable: if the cert isn't validated yet,
# add the printed CNAME in the other account, then re-run to finish.
#
# Usage:
#   DOMAIN_NAME=nataliernathan.com ./scripts/setup-alb-asg.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUTS="${SCRIPT_DIR}/aws-setup-outputs.env"
CONFIG="${SCRIPT_DIR}/aws-setup.config"

# Load setup outputs + config when present (AWS_REGION, NAME_PREFIX, DOMAIN_NAME...).
[ -f "$CONFIG" ] && { set -a; . "$CONFIG"; set +a; }
[ -f "$OUTPUTS" ] && { set -a; . "$OUTPUTS"; set +a; }

AWS_REGION="${AWS_REGION:-us-west-2}"
NAME_PREFIX="${NAME_PREFIX:-ultraviris}"
DOMAIN_NAME="${DOMAIN_NAME:-nataliernathan.com}"
INSTANCE_PROFILE="${INSTANCE_PROFILE:-${NAME_PREFIX}-ec2}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
APP_TAG="${APP_TAG:-ultraviris}"
ASG_MIN="${ASG_MIN:-1}"
ASG_DESIRED="${ASG_DESIRED:-1}"
ASG_MAX="${ASG_MAX:-2}"
HEALTH_PATH="${HEALTH_PATH:-/api/health/status}"
SSL_POLICY="${SSL_POLICY:-ELBSecurityPolicy-TLS13-1-2-2021-06}"
# Set CERT_WAIT=0 to skip blocking on ACM validation (just print the record).
CERT_WAIT="${CERT_WAIT:-1}"

command -v aws >/dev/null || { echo "aws CLI v2 is required" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq is required" >&2; exit 1; }

aws() { command aws --region "$AWS_REGION" "$@"; }
log() { echo "== $*"; }
warn() { echo "!! $*" >&2; }

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
log "Account $ACCOUNT_ID  Region $AWS_REGION  Domain $DOMAIN_NAME"

IMAGE_TAG_PARAM="${IMAGE_TAG_PARAM:-/ultraviris/image-tag}"
CPU_TARGET="${CPU_TARGET:-50}"  # target-tracking ASG average CPU %

# ── Image-tag pointer (SSM Parameter Store) ───────────────────────────────────
# Instances read this on boot to know which tag to run. The deploy pipeline
# updates it (to the git sha) before triggering an instance refresh.
if ! aws ssm get-parameter --name "$IMAGE_TAG_PARAM" >/dev/null 2>&1; then
  log "Creating SSM parameter $IMAGE_TAG_PARAM = latest"
  aws ssm put-parameter --name "$IMAGE_TAG_PARAM" --type String --value latest >/dev/null
fi

# ── Network: default VPC + its default subnets (need >= 2 AZs for an ALB) ──────
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)}"
[ "$VPC_ID" = "None" ] && { echo "No default VPC; set VPC_ID/SUBNET_IDS." >&2; exit 1; }

SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text)}"
SUBNET_COUNT="$(echo "$SUBNET_IDS" | wc -w | tr -d ' ')"
if [ "$SUBNET_COUNT" -lt 2 ]; then
  echo "Need >= 2 subnets across AZs for an ALB (found $SUBNET_COUNT)." >&2
  exit 1
fi
SUBNET_CSV="$(echo "$SUBNET_IDS" | tr ' \t' ',,' | tr -s ',')"
log "VPC $VPC_ID  Subnets: $SUBNET_IDS"

# ── Security groups ───────────────────────────────────────────────────────────
ensure_sg() {  # name description -> prints group id
  local name="$1" desc="$2" id
  id="$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=$name" "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
  if [ "$id" = "None" ] || [ -z "$id" ]; then
    id="$(aws ec2 create-security-group --group-name "$name" \
      --description "$desc" --vpc-id "$VPC_ID" --query GroupId --output text)"
  fi
  echo "$id"
}

authorize() {  # sg proto port (cidr|sg=<id>)
  local sg="$1" proto="$2" port="$3" src="$4"
  if [[ "$src" == sg=* ]]; then
    aws ec2 authorize-security-group-ingress --group-id "$sg" \
      --ip-permissions "IpProtocol=$proto,FromPort=$port,ToPort=$port,UserIdGroupPairs=[{GroupId=${src#sg=}}]" \
      >/dev/null 2>&1 || true
  else
    aws ec2 authorize-security-group-ingress --group-id "$sg" \
      --protocol "$proto" --port "$port" --cidr "$src" >/dev/null 2>&1 || true
  fi
}

ALB_SG="$(ensure_sg "${NAME_PREFIX}-alb" "ultraviris ALB (public 80/443)")"
APP_SG="$(ensure_sg "${NAME_PREFIX}-app" "ultraviris app (from ALB only)")"
log "ALB SG $ALB_SG  App SG $APP_SG"
authorize "$ALB_SG" tcp 80  0.0.0.0/0
authorize "$ALB_SG" tcp 443 0.0.0.0/0
# Instances accept HTTP only from the ALB.
authorize "$APP_SG" tcp 80  "sg=$ALB_SG"

# ── ACM certificate (DNS-validated) ───────────────────────────────────────────
CERT_ARN="${CERT_ARN:-$(aws acm list-certificates \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN_NAME'].CertificateArn | [0]" \
  --output text 2>/dev/null || echo None)}"
if [ "$CERT_ARN" = "None" ] || [ -z "$CERT_ARN" ]; then
  log "Requesting ACM certificate for $DOMAIN_NAME"
  CERT_ARN="$(aws acm request-certificate --domain-name "$DOMAIN_NAME" \
    --validation-method DNS \
    --options CertificateTransparencyLoggingPreference=ENABLED \
    --query CertificateArn --output text)"
  sleep 5
fi
log "Certificate: $CERT_ARN"

CERT_STATUS="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" \
  --query 'Certificate.Status' --output text)"
if [ "$CERT_STATUS" != "ISSUED" ]; then
  echo ""
  warn "Certificate status: $CERT_STATUS — add this CNAME in the Route 53 account that hosts $DOMAIN_NAME:"
  aws acm describe-certificate --certificate-arn "$CERT_ARN" \
    --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output table
  if [ "$CERT_WAIT" = "1" ]; then
    log "Waiting for the certificate to validate (up to ~10 min)..."
    if ! aws acm wait certificate-validated --certificate-arn "$CERT_ARN"; then
      warn "Cert not validated yet. Add the CNAME above, then re-run this script."
      exit 2
    fi
  else
    warn "CERT_WAIT=0 — add the CNAME, then re-run to finish the HTTPS listener."
    exit 2
  fi
fi
log "Certificate is ISSUED"

# ── Launch template ───────────────────────────────────────────────────────────
AMI_ID="${AMI_ID:-$(aws ssm get-parameters \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query 'Parameters[0].Value' --output text)}"
USERDATA_B64="$(base64 < "${SCRIPT_DIR}/userdata.sh" | tr -d '\n')"
log "AMI $AMI_ID  Launch template ${NAME_PREFIX}-lt"

LT_DATA="$(jq -n \
  --arg ami "$AMI_ID" --arg type "$INSTANCE_TYPE" --arg profile "$INSTANCE_PROFILE" \
  --arg sg "$APP_SG" --arg ud "$USERDATA_B64" --arg app "$APP_TAG" --arg name "$NAME_PREFIX" \
  '{
    ImageId: $ami,
    InstanceType: $type,
    IamInstanceProfile: { Name: $profile },
    SecurityGroupIds: [ $sg ],
    UserData: $ud,
    MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
    TagSpecifications: [
      { ResourceType: "instance", Tags: [ {Key:"Name",Value:$name}, {Key:"App",Value:$app} ] }
    ]
  }')"

if aws ec2 describe-launch-templates --launch-template-names "${NAME_PREFIX}-lt" >/dev/null 2>&1; then
  LT_ID="$(aws ec2 create-launch-template-version \
    --launch-template-name "${NAME_PREFIX}-lt" \
    --launch-template-data "$LT_DATA" \
    --query 'LaunchTemplateVersion.LaunchTemplateId' --output text)"
else
  LT_ID="$(aws ec2 create-launch-template \
    --launch-template-name "${NAME_PREFIX}-lt" \
    --launch-template-data "$LT_DATA" \
    --query 'LaunchTemplate.LaunchTemplateId' --output text)"
fi
log "Launch template $LT_ID (using \$Latest version)"

# ── Target group ──────────────────────────────────────────────────────────────
TG_ARN="$(aws elbv2 describe-target-groups --names "${NAME_PREFIX}-tg" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo None)"
if [ "$TG_ARN" = "None" ] || [ -z "$TG_ARN" ]; then
  TG_ARN="$(aws elbv2 create-target-group \
    --name "${NAME_PREFIX}-tg" \
    --protocol HTTP --port 80 --vpc-id "$VPC_ID" --target-type instance \
    --health-check-protocol HTTP --health-check-path "$HEALTH_PATH" \
    --health-check-interval-seconds 30 --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
    --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
fi
log "Target group $TG_ARN"

# ── Application Load Balancer ──────────────────────────────────────────────────
ALB_ARN="$(aws elbv2 describe-load-balancers --names "${NAME_PREFIX}-alb" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || echo None)"
if [ "$ALB_ARN" = "None" ] || [ -z "$ALB_ARN" ]; then
  # shellcheck disable=SC2086
  ALB_ARN="$(aws elbv2 create-load-balancer --name "${NAME_PREFIX}-alb" \
    --type application --scheme internet-facing \
    --subnets $SUBNET_IDS --security-groups "$ALB_SG" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
fi
log "ALB $ALB_ARN — waiting until active..."
aws elbv2 wait load-balancer-available --load-balancer-arns "$ALB_ARN"

ALB_DNS="$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text)"
ALB_ZONE="$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)"

# ── Listeners: 443 (forward, TLS) and 80 (redirect → 443) ─────────────────────
HTTPS_ARN="$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`443\`].ListenerArn | [0]" --output text 2>/dev/null || echo None)"
if [ "$HTTPS_ARN" = "None" ] || [ -z "$HTTPS_ARN" ]; then
  HTTPS_ARN="$(aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" \
    --protocol HTTPS --port 443 \
    --certificates "CertificateArn=$CERT_ARN" \
    --ssl-policy "$SSL_POLICY" \
    --default-actions "Type=forward,TargetGroupArn=$TG_ARN" \
    --query 'Listeners[0].ListenerArn' --output text)"
  log "Created HTTPS:443 listener"
else
  aws elbv2 modify-listener --listener-arn "$HTTPS_ARN" \
    --certificates "CertificateArn=$CERT_ARN" --ssl-policy "$SSL_POLICY" \
    --default-actions "Type=forward,TargetGroupArn=$TG_ARN" >/dev/null
  log "Updated HTTPS:443 listener"
fi

HTTP_ARN="$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`80\`].ListenerArn | [0]" --output text 2>/dev/null || echo None)"
REDIRECT='Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'
if [ "$HTTP_ARN" = "None" ] || [ -z "$HTTP_ARN" ]; then
  aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" \
    --protocol HTTP --port 80 --default-actions "$REDIRECT" >/dev/null
  log "Created HTTP:80 → HTTPS redirect"
else
  aws elbv2 modify-listener --listener-arn "$HTTP_ARN" \
    --default-actions "$REDIRECT" >/dev/null
  log "Updated HTTP:80 → HTTPS redirect"
fi

# ── Auto Scaling Group ────────────────────────────────────────────────────────
if aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "${NAME_PREFIX}-asg" \
  --query 'AutoScalingGroups[0].AutoScalingGroupName' --output text 2>/dev/null \
  | grep -q "${NAME_PREFIX}-asg"; then
  log "Updating ASG ${NAME_PREFIX}-asg"
  aws autoscaling update-auto-scaling-group \
    --auto-scaling-group-name "${NAME_PREFIX}-asg" \
    --launch-template "LaunchTemplateId=$LT_ID,Version=\$Latest" \
    --min-size "$ASG_MIN" --max-size "$ASG_MAX" --desired-capacity "$ASG_DESIRED" \
    --vpc-zone-identifier "$SUBNET_CSV" \
    --health-check-type ELB --health-check-grace-period 120
  aws autoscaling attach-load-balancer-target-groups \
    --auto-scaling-group-name "${NAME_PREFIX}-asg" --target-group-arns "$TG_ARN" >/dev/null 2>&1 || true
else
  log "Creating ASG ${NAME_PREFIX}-asg ($ASG_MIN/$ASG_DESIRED/$ASG_MAX)"
  aws autoscaling create-auto-scaling-group \
    --auto-scaling-group-name "${NAME_PREFIX}-asg" \
    --launch-template "LaunchTemplateId=$LT_ID,Version=\$Latest" \
    --min-size "$ASG_MIN" --max-size "$ASG_MAX" --desired-capacity "$ASG_DESIRED" \
    --vpc-zone-identifier "$SUBNET_CSV" \
    --target-group-arns "$TG_ARN" \
    --health-check-type ELB --health-check-grace-period 120 \
    --tags \
      "Key=Name,Value=${NAME_PREFIX},PropagateAtLaunch=true" \
      "Key=App,Value=${APP_TAG},PropagateAtLaunch=true"
fi

# ── Auto scaling policy: target-tracking on average CPU ───────────────────────
log "Target-tracking scaling policy (avg CPU ${CPU_TARGET}%)"
TT_CONFIG="$(jq -n --argjson cpu "$CPU_TARGET" '{
  PredefinedMetricSpecification: { PredefinedMetricType: "ASGAverageCPUUtilization" },
  TargetValue: $cpu
}')"
# A brand-new ASG triggers creation of the AWSServiceRoleForAutoScaling
# service-linked role; PutScalingPolicy can fail with ServiceLinkedRoleFailure
# until it propagates (usually <1 min), so retry with backoff.
sp_attempts="${SCALING_POLICY_RETRIES:-10}"; sp_delay=6
for sp_i in $(seq 1 "$sp_attempts"); do
  if aws autoscaling put-scaling-policy \
    --auto-scaling-group-name "${NAME_PREFIX}-asg" \
    --policy-name "${NAME_PREFIX}-cpu-target" \
    --policy-type TargetTrackingScaling \
    --target-tracking-configuration "$TT_CONFIG" >/dev/null 2>&1; then
    break
  fi
  if [ "$sp_i" -eq "$sp_attempts" ]; then
    warn "Scaling policy still failing after $sp_attempts attempts; showing the error:"
    aws autoscaling put-scaling-policy \
      --auto-scaling-group-name "${NAME_PREFIX}-asg" \
      --policy-name "${NAME_PREFIX}-cpu-target" \
      --policy-type TargetTrackingScaling \
      --target-tracking-configuration "$TT_CONFIG" >/dev/null
    exit 1
  fi
  warn "Scaling policy not ready (attempt $sp_i/$sp_attempts), waiting ${sp_delay}s for the service-linked role..."
  sleep "$sp_delay"
  [ "$sp_delay" -lt 30 ] && sp_delay=$((sp_delay * 2))
done

# ── Summary + the DNS records to add in the OTHER account's Route 53 ──────────
cat <<EOF

────────────────────────────────────────────────────────────────────────────
ALB + ASG + HTTPS provisioned.

  ALB DNS name:        $ALB_DNS
  ALB hosted zone id:  $ALB_ZONE
  Certificate:         $CERT_ARN
  Target group:        ${NAME_PREFIX}-tg
  ASG:                 ${NAME_PREFIX}-asg  (min $ASG_MIN / desired $ASG_DESIRED / max $ASG_MAX)

ACTION REQUIRED — in the AWS account that hosts the Route 53 zone for $DOMAIN_NAME,
create an ALIAS A record for the apex pointing at the ALB:

  Name:               $DOMAIN_NAME
  Type:               A (Alias = Yes)
  Alias target:       $ALB_DNS
  Alias hosted zone:  $ALB_ZONE
  Evaluate health:    No

If that zone is also Route 53 (different account), the change-resource-record-sets
JSON is:

  {
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$DOMAIN_NAME",
        "Type": "A",
        "AliasTarget": {
          "DNSName": "$ALB_DNS",
          "HostedZoneId": "$ALB_ZONE",
          "EvaluateTargetHealth": false
        }
      }
    }]
  }

Then browse https://$DOMAIN_NAME/ (give the ASG a few minutes to pass health checks).
────────────────────────────────────────────────────────────────────────────
EOF
