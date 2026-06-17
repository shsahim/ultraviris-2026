#!/bin/bash
#
# Runs ON the EC2 instance. Pulls a specific image tag from ECR and (re)starts
# the ultraviris container, then waits for it to report healthy. If the new
# image is unhealthy it rolls back to the previously running image.
#
# Invoked two ways:
#   * by scripts/userdata.sh on first boot:  deploy.sh latest
#   * by the GitHub deploy pipeline via SSM:  deploy.sh <git-short-sha>
#
# Configuration comes from the environment (with sane defaults) and from the
# files userdata.sh writes into APP_DIR (app.env, optional ssh_key.pem).
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-west-2}"
ECR_REPO="${ECR_REPO:-ultraviris}"
APP_DIR="${APP_DIR:-/opt/ultraviris}"
CONTAINER="${CONTAINER:-ultraviris}"
HOST_PORT="${HOST_PORT:-80}"
APP_PORT="${APP_PORT:-3000}"

# Tag to deploy: first CLI arg, else $IMAGE_TAG, else "latest".
IMAGE_TAG="${1:-${IMAGE_TAG:-latest}}"

ENV_FILE="$APP_DIR/app.env"
SSH_KEY_FILE="$APP_DIR/ssh_key.pem"
TUNNEL_MARKER="$APP_DIR/dbtunnel.enabled"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — run userdata.sh / fetch secrets first." >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

echo "== Deploying ${IMAGE} =="

echo "== Authenticating to ECR and pulling image =="
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"
docker pull "$IMAGE"

# Decide how the container reaches the database (mirrors lib/db.ts):
#   1) Host SSH tunnel (dbtunnel.enabled): the EC2 host maintains a persistent
#      SSH tunnel (systemd) forwarding a local port to RDS. The container talks
#      directly to that port on the host gateway, with the in-app tunnel off.
#   2) In-container tunnel (ssh_key.pem present, no host tunnel): the app opens
#      its own SSH tunnel using the mounted key (used by local `run-local`).
#   3) Direct: connect straight to RDS via security groups.
DB_ARGS=()
if [ -f "$TUNNEL_MARKER" ]; then
  # shellcheck disable=SC1090
  . "$TUNNEL_MARKER"   # provides LOCAL_PORT (and DOCKER_GW, informational)
  DB_ARGS+=( --add-host "host.docker.internal:host-gateway" \
             -e "DB_USE_SSH_TUNNEL=false" \
             -e "MYSQL_HOST=host.docker.internal" \
             -e "MYSQL_PORT=${LOCAL_PORT:-3306}" )
  echo "== DB: via host SSH tunnel on host.docker.internal:${LOCAL_PORT:-3306} =="
elif [ -f "$SSH_KEY_FILE" ]; then
  DB_ARGS+=( -e "SSH_PRIVATE_KEY_PATH=/run/ssh_key.pem" \
             -v "$SSH_KEY_FILE:/run/ssh_key.pem:ro" )
  echo "== DB: via in-container SSH tunnel =="
else
  DB_ARGS+=( -e "DB_USE_SSH_TUNNEL=false" )
  echo "== DB: direct connection via security groups =="
fi

# Remember what's running so we can roll back a bad deploy.
PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"

start_container() {
  local image="$1"
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p "${HOST_PORT}:${APP_PORT}" \
    --env-file "$ENV_FILE" \
    "${DB_ARGS[@]}" \
    --health-cmd "wget -q -T 5 --spider http://127.0.0.1:${APP_PORT}/api/health/status || exit 1" \
    --health-interval 30s \
    --health-timeout 5s \
    --health-start-period 40s \
    --health-retries 3 \
    "$image"
}

wait_healthy() {
  local i status
  for i in $(seq 1 30); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo starting)"
    echo "  health: $status"
    [ "$status" = "healthy" ] && return 0
    [ "$status" = "unhealthy" ] && return 1
    sleep 5
  done
  return 1
}

echo "== Starting container on ${IMAGE} =="
start_container "$IMAGE"

if wait_healthy; then
  echo "Deploy OK: ${IMAGE}"
  # Reclaim disk from old image layers (best-effort).
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "!! New image is unhealthy — recent logs:" >&2
docker logs --tail 50 "$CONTAINER" >&2 || true

if [ -n "$PREVIOUS_IMAGE" ] && [ "$PREVIOUS_IMAGE" != "$IMAGE" ]; then
  echo "== Rolling back to ${PREVIOUS_IMAGE} =="
  start_container "$PREVIOUS_IMAGE"
  if wait_healthy; then
    echo "Rolled back to ${PREVIOUS_IMAGE}; deploy of ${IMAGE} failed." >&2
  else
    echo "Rollback to ${PREVIOUS_IMAGE} also unhealthy." >&2
  fi
fi

exit 1
