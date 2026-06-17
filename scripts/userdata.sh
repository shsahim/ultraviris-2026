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

AWS_REGION="us-west-2"
ECR_REPO="ultraviris"
APP_DIR="/opt/ultraviris"
CONTAINER="ultraviris"
HOST_PORT=80
APP_PORT=3000
ENV_SECRET="ultraviris/env"
SSH_KEY_SECRET="ultraviris/ssh-key"
# Which image tag a freshly-booted instance should run. The deploy pipeline pins
# this to the deployed git sha (SSM Parameter Store) so ASG instance-refresh and
# scale-out launches come up on exactly the deployed version; default to latest.
IMAGE_TAG_PARAM="/ultraviris/image-tag"

echo "== Installing Docker and tooling =="
dnf update -y
dnf install -y docker jq cronie
systemctl enable --now docker
systemctl enable --now crond

mkdir -p "$APP_DIR"

echo "== Fetching secrets =="
aws secretsmanager get-secret-value --region "$AWS_REGION" \
  --secret-id "$ENV_SECRET" --query SecretString --output text > "$APP_DIR/app.env"
chmod 600 "$APP_DIR/app.env"

# Pull a value out of the dotenv-style app.env (strips surrounding quotes).
getenv() { grep -E "^$1=" "$APP_DIR/app.env" | head -1 | cut -d= -f2- | tr -d '"'; }

# Database access. When the SSH key secret exists we run a persistent SSH tunnel
# on the *host* (systemd) that forwards a local port to RDS through the bastion;
# the container then connects to that port via the host gateway (see deploy.sh).
# This keeps a single tunnel per instance and keeps the key out of the container.
# Without the key secret, the app connects directly to RDS via security groups.
rm -f "$APP_DIR/dbtunnel.enabled"
if aws secretsmanager get-secret-value --region "$AWS_REGION" \
  --secret-id "$SSH_KEY_SECRET" --query SecretString --output text \
  > "$APP_DIR/ssh_key.pem" 2>/dev/null; then
  chmod 600 "$APP_DIR/ssh_key.pem"
  echo "== SSH key secret found — configuring host DB tunnel =="

  TUNNEL_DB_HOST="$(getenv MYSQL_HOST)"
  TUNNEL_DB_PORT="$(getenv MYSQL_PORT)"; TUNNEL_DB_PORT="${TUNNEL_DB_PORT:-3306}"
  TUNNEL_SSH_HOST="$(getenv SSH_HOST)"
  TUNNEL_SSH_USER="$(getenv SSH_USER)"; TUNNEL_SSH_USER="${TUNNEL_SSH_USER:-ec2-user}"
  TUNNEL_SSH_PORT="$(getenv SSH_PORT)"; TUNNEL_SSH_PORT="${TUNNEL_SSH_PORT:-22}"
  TUNNEL_SSH_PASS="$(getenv SSH_PASSPHRASE)"
  LOCAL_PORT="${TUNNEL_LOCAL_PORT:-3306}"

  # ssh in a systemd unit must be non-interactive, so strip the key passphrase
  # into a host-only copy. (The encrypted original stays in $APP_DIR/ssh_key.pem.)
  cp "$APP_DIR/ssh_key.pem" "$APP_DIR/ssh_key_tunnel.pem"
  chmod 600 "$APP_DIR/ssh_key_tunnel.pem"
  ssh-keygen -p -f "$APP_DIR/ssh_key_tunnel.pem" -P "$TUNNEL_SSH_PASS" -N "" >/dev/null

  # Bind the forwarded port to the docker bridge gateway so only containers on
  # this host can reach it (not the instance's public interface).
  DOCKER_GW="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)"

  cat > /etc/systemd/system/ultraviris-dbtunnel.service <<EOF
[Unit]
Description=ultraviris RDS SSH tunnel via bastion ${TUNNEL_SSH_HOST}
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/bin/ssh -N \\
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \\
  -i ${APP_DIR}/ssh_key_tunnel.pem -p ${TUNNEL_SSH_PORT} \\
  -L ${DOCKER_GW}:${LOCAL_PORT}:${TUNNEL_DB_HOST}:${TUNNEL_DB_PORT} \\
  ${TUNNEL_SSH_USER}@${TUNNEL_SSH_HOST}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now ultraviris-dbtunnel.service

  # Record the tunnel endpoint for deploy.sh.
  cat > "$APP_DIR/dbtunnel.enabled" <<EOF
DOCKER_GW=${DOCKER_GW}
LOCAL_PORT=${LOCAL_PORT}
EOF

  echo "== Waiting for the DB tunnel on ${DOCKER_GW}:${LOCAL_PORT} =="
  for _ in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/${DOCKER_GW}/${LOCAL_PORT}") 2>/dev/null; then
      exec 3>&- 3<&-
      echo "Tunnel is up."
      break
    fi
    sleep 2
  done
else
  rm -f "$APP_DIR/ssh_key.pem" "$APP_DIR/ssh_key_tunnel.pem"
  systemctl disable --now ultraviris-dbtunnel.service 2>/dev/null || true
  rm -f /etc/systemd/system/ultraviris-dbtunnel.service
  systemctl daemon-reload 2>/dev/null || true
  echo "No SSH key secret — deploy.sh will connect directly to RDS via security groups."
fi

echo "== Installing the deploy script from S3 =="
# deploy.sh (pull + run + healthcheck + rollback) is the single source of truth
# for starting the container — shared by this boot script and the SSM deploy
# pipeline. setup-aws.sh uploads it to s3://<bucket>/ops/deploy.sh.
BUCKET="$(grep -E '^S3_BUCKET=' "$APP_DIR/app.env" | cut -d= -f2- | tr -d '"' || true)"
if [ -z "$BUCKET" ]; then
  echo "S3_BUCKET not found in app.env — cannot fetch deploy.sh." >&2
  exit 1
fi
aws s3 cp "s3://${BUCKET}/ops/deploy.sh" "$APP_DIR/deploy.sh"
chmod +x "$APP_DIR/deploy.sh"

IMAGE_TAG="$(aws ssm get-parameter --region "$AWS_REGION" \
  --name "$IMAGE_TAG_PARAM" --query 'Parameter.Value' --output text 2>/dev/null || echo latest)"

echo "== Initial deploy (tag: ${IMAGE_TAG}) =="
AWS_REGION="$AWS_REGION" ECR_REPO="$ECR_REPO" APP_DIR="$APP_DIR" \
  CONTAINER="$CONTAINER" HOST_PORT="$HOST_PORT" APP_PORT="$APP_PORT" \
  "$APP_DIR/deploy.sh" "$IMAGE_TAG"

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
