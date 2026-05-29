#!/bin/bash
#
# EC2 user-data for running ultraviris in Docker (Amazon Linux 2023, ARM64/Graviton).
#
# Prerequisites on the instance/launch template:
#   * Instance IAM role with permissions for:
#       - ecr:GetAuthorizationToken, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer
#       - secretsmanager:GetSecretValue on the two secrets below
#       - ses:SendEmail and s3:* (scoped) if using the instance role for SES/S3
#   * Secrets Manager secrets:
#       - "ultraviris/env": dotenv-formatted text (the app's environment, e.g.
#         contents of .env.example filled in — including HEALTH_CHECK_SECRET)
#       - "ultraviris/ssh-key": the SSH private key PEM used for the DB tunnel
#
# Configuration (edit as needed):
set -euo pipefail
exec > >(tee /var/log/ultraviris-userdata.log) 2>&1

AWS_REGION="us-east-1"
ECR_REPO="ultraviris"
IMAGE_TAG="latest"
APP_DIR="/opt/ultraviris"
CONTAINER="ultraviris"
HOST_PORT=80
APP_PORT=3000
ENV_SECRET="ultraviris/env"
SSH_KEY_SECRET="ultraviris/ssh-key"

echo "== Installing Docker and tooling =="
dnf update -y
dnf install -y docker jq cronie
systemctl enable --now docker
systemctl enable --now crond

echo "== Resolving ECR registry =="
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

mkdir -p "$APP_DIR"

echo "== Fetching secrets =="
aws secretsmanager get-secret-value --region "$AWS_REGION" \
  --secret-id "$ENV_SECRET" --query SecretString --output text > "$APP_DIR/app.env"
chmod 600 "$APP_DIR/app.env"

aws secretsmanager get-secret-value --region "$AWS_REGION" \
  --secret-id "$SSH_KEY_SECRET" --query SecretString --output text > "$APP_DIR/ssh_key.pem"
chmod 600 "$APP_DIR/ssh_key.pem"

echo "== Authenticating to ECR and pulling image =="
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"
docker pull "$IMAGE"

echo "== (Re)starting container with startup health checks =="
docker rm -f "$CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${APP_PORT}" \
  --env-file "$APP_DIR/app.env" \
  -e "SSH_PRIVATE_KEY_PATH=/run/ssh_key.pem" \
  -v "$APP_DIR/ssh_key.pem:/run/ssh_key.pem:ro" \
  --health-cmd "wget -q -T 5 --spider http://127.0.0.1:${APP_PORT}/api/health/status || exit 1" \
  --health-interval 30s \
  --health-timeout 5s \
  --health-start-period 40s \
  --health-retries 3 \
  "$IMAGE"

echo "== Waiting for the container to report healthy =="
for i in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo starting)"
  echo "  health: $status"
  if [ "$status" = "healthy" ]; then
    echo "Container is healthy."
    break
  fi
  if [ "$status" = "unhealthy" ]; then
    echo "Container went unhealthy — dumping logs:" >&2
    docker logs --tail 50 "$CONTAINER" >&2 || true
  fi
  sleep 5
done

echo "== Installing the health-alert cron (every 5 min) =="
# Each instance polls its local app; cross-instance duplicate emails are
# prevented by the shared health_alerts table. For a large ASG you may prefer a
# single EventBridge schedule hitting the load balancer instead of a host cron.
HEALTH_SECRET="$(grep -E '^HEALTH_CHECK_SECRET=' "$APP_DIR/app.env" | cut -d= -f2- | tr -d '\"' || true)"
if [ -n "$HEALTH_SECRET" ]; then
  cat > /etc/cron.d/ultraviris-health <<EOF
*/5 * * * * root curl -fsS -H "Authorization: Bearer ${HEALTH_SECRET}" http://127.0.0.1:${HOST_PORT}/api/health/cron >/dev/null 2>&1
EOF
  chmod 644 /etc/cron.d/ultraviris-health
  echo "Health-alert cron installed."
else
  echo "HEALTH_CHECK_SECRET not found in env; skipping alert cron." >&2
fi

echo "== Done =="
