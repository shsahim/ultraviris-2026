#!/bin/bash
#
# Launches a single EC2 instance (Amazon Linux 2023, ARM64/Graviton) that runs
# the ultraviris container. The instance:
#   * uses the ultraviris-ec2 instance profile (ECR pull, Secrets Manager, S3, SES)
#   * is registered with SSM (AmazonSSMManagedInstanceCore on the role) so the
#     deploy pipeline can push new images to it via Run Command
#   * is tagged App=ultraviris so the pipeline can target it
#   * boots scripts/userdata.sh, which fetches secrets + deploy.sh and starts the app
#
# Prereqs: run scripts/setup-aws.sh first (creates the instance profile, S3
# bucket, secrets, and uploads deploy.sh). Requires AWS CLI v2 + a default VPC.
#
# Usage:
#   ./scripts/launch-ec2.sh
#   INSTANCE_TYPE=t4g.medium SSH_CIDR=1.2.3.4/32 ./scripts/launch-ec2.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUTS="${SCRIPT_DIR}/aws-setup-outputs.env"

# Load values produced by setup-aws.sh when present (AWS_REGION, S3_BUCKET, ...).
if [ -f "$OUTPUTS" ]; then
  set -a; . "$OUTPUTS"; set +a
fi

AWS_REGION="${AWS_REGION:-us-west-2}"
NAME_PREFIX="${NAME_PREFIX:-ultraviris}"
INSTANCE_PROFILE="${INSTANCE_PROFILE:-${NAME_PREFIX}-ec2}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
APP_TAG="${APP_TAG:-ultraviris}"
SG_NAME="${SG_NAME:-${NAME_PREFIX}-web}"
# Set SSH_CIDR (e.g. 1.2.3.4/32) to also open port 22; left empty, no SSH access.
SSH_CIDR="${SSH_CIDR:-}"

command -v aws >/dev/null || { echo "aws CLI v2 is required" >&2; exit 1; }

awsq() { aws --region "$AWS_REGION" "$@"; }

echo "== Region: $AWS_REGION  Profile: $INSTANCE_PROFILE  Type: $INSTANCE_TYPE"

# Default VPC + a default subnet inside it.
VPC_ID="$(awsq ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
  echo "No default VPC found. Set VPC_ID and SUBNET_ID explicitly." >&2
  exit 1
fi
SUBNET_ID="${SUBNET_ID:-$(awsq ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[0].SubnetId' --output text)}"
echo "== VPC: $VPC_ID  Subnet: $SUBNET_ID"

# Security group (reuse if it already exists).
SG_ID="$(awsq ec2 describe-security-groups \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID="$(awsq ec2 create-security-group --group-name "$SG_NAME" \
    --description "ultraviris web (HTTP)" --vpc-id "$VPC_ID" \
    --query GroupId --output text)"
  echo "== Created security group $SG_ID"
  awsq ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
else
  echo "== Reusing security group $SG_ID"
fi
if [ -n "$SSH_CIDR" ]; then
  awsq ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr "$SSH_CIDR" >/dev/null 2>&1 \
    && echo "== Opened SSH (22) to $SSH_CIDR" || true
fi

# Latest AL2023 ARM64 AMI from the public SSM parameter (always current).
AMI_ID="$(awsq ssm get-parameters \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query 'Parameters[0].Value' --output text)"
echo "== AMI: $AMI_ID"

echo "== Launching instance..."
INSTANCE_ID="$(awsq ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --iam-instance-profile "Name=$INSTANCE_PROFILE" \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --user-data "file://${SCRIPT_DIR}/userdata.sh" \
  --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Name,Value=${NAME_PREFIX}},{Key=App,Value=${APP_TAG}}]" \
  --query 'Instances[0].InstanceId' --output text)"
echo "== Instance: $INSTANCE_ID"

echo "== Waiting for the instance to enter 'running'..."
awsq ec2 wait instance-running --instance-ids "$INSTANCE_ID"
PUBLIC_IP="$(awsq ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

cat <<EOF

Instance running: $INSTANCE_ID
Public IP:        $PUBLIC_IP
App URL:          http://$PUBLIC_IP/

First boot runs userdata.sh (installs Docker, fetches secrets + deploy.sh,
pulls the image, starts the container). Give it ~2-4 minutes, then check:

  curl -I http://$PUBLIC_IP/api/health/status

The instance is tagged App=$APP_TAG, so pushing to main will deploy to it.
EOF
