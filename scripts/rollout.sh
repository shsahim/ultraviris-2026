#!/bin/bash
# Rolls out an image tag that already exists in ECR. Pins the tag in SSM
# Parameter Store (so new launches/scale-out use it), then performs a
# zero-downtime ASG instance refresh if an Auto Scaling Group exists, or an
# in-place SSM Run Command deploy to tagged instances otherwise. On failure it
# reverts the SSM tag pointer to the previous value.
#
# This is the same logic the GitHub Actions deploy job runs, so `make ship` /
# `make deploy` give you a local path that bypasses CI entirely.
#
# Usage:
#   scripts/rollout.sh <tag>
#
# Env (with defaults):
#   AWS_REGION        us-west-2
#   APP_TAG           ultraviris        (EC2 tag:App for in-place fallback)
#   ASG_NAME          ultraviris-asg
#   IMAGE_TAG_PARAM   /ultraviris/image-tag
#   DEPLOY_SCRIPT     /opt/ultraviris/deploy.sh
set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: $0 <image-tag>" >&2
  exit 2
fi

AWS_REGION="${AWS_REGION:-us-west-2}"
APP_TAG="${APP_TAG:-ultraviris}"
ASG_NAME="${ASG_NAME:-ultraviris-asg}"
IMAGE_TAG_PARAM="${IMAGE_TAG_PARAM:-/ultraviris/image-tag}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-/opt/ultraviris/deploy.sh}"

aws() { command aws --region "$AWS_REGION" "$@"; }

# ── Pin the tag, remembering the previous value so we can revert on failure ──
PREV="$(aws ssm get-parameter --name "$IMAGE_TAG_PARAM" \
  --query 'Parameter.Value' --output text 2>/dev/null || echo latest)"
aws ssm put-parameter --name "$IMAGE_TAG_PARAM" --type String \
  --value "$TAG" --overwrite >/dev/null
echo "Pinned $IMAGE_TAG_PARAM = $TAG (was $PREV)"

revert() {
  echo "Reverting $IMAGE_TAG_PARAM -> $PREV"
  aws ssm put-parameter --name "$IMAGE_TAG_PARAM" --type String \
    --value "$PREV" --overwrite >/dev/null || true
}

ASG_EXISTS="$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$ASG_NAME" \
  --query 'AutoScalingGroups[0].AutoScalingGroupName' --output text 2>/dev/null || echo None)"

# ── Path A: zero-downtime rolling replacement via instance refresh ───────────
if [ "$ASG_EXISTS" = "$ASG_NAME" ]; then
  echo "Starting instance refresh on $ASG_NAME for tag $TAG"
  REFRESH_ID="$(aws autoscaling start-instance-refresh \
    --auto-scaling-group-name "$ASG_NAME" \
    --preferences 'MinHealthyPercentage=100,InstanceWarmup=90' \
    --query InstanceRefreshId --output text)"
  echo "InstanceRefreshId: $REFRESH_ID"

  STATUS=Pending
  for _ in $(seq 1 120); do
    sleep 15
    STATUS="$(aws autoscaling describe-instance-refreshes \
      --auto-scaling-group-name "$ASG_NAME" --instance-refresh-ids "$REFRESH_ID" \
      --query 'InstanceRefreshes[0].Status' --output text)"
    PCT="$(aws autoscaling describe-instance-refreshes \
      --auto-scaling-group-name "$ASG_NAME" --instance-refresh-ids "$REFRESH_ID" \
      --query 'InstanceRefreshes[0].PercentageComplete' --output text)"
    echo "  refresh: $STATUS (${PCT:-0}%)"
    case "$STATUS" in
      Successful|Failed|Cancelled|RollbackFailed|RollbackSuccessful) break ;;
    esac
  done

  if [ "$STATUS" != "Successful" ]; then
    echo "Instance refresh ended as '$STATUS'." >&2
    revert
    exit 1
  fi
  echo "Deploy succeeded (instance refresh): $TAG"
  exit 0
fi

# ── Path B: no ASG — in-place deploy to tagged instances via SSM ─────────────
echo "No ASG '$ASG_NAME'; deploying in place to instances tagged App=$APP_TAG"
PARAMS="$(jq -n --arg cmd "$DEPLOY_SCRIPT $TAG" '{commands: [$cmd]}')"
CMD_ID="$(aws ssm send-command \
  --document-name AWS-RunShellScript \
  --comment "Manual deploy ultraviris $TAG" \
  --targets "Key=tag:App,Values=$APP_TAG" \
  --parameters "$PARAMS" \
  --query Command.CommandId --output text)"
echo "SSM CommandId: $CMD_ID"

for _ in $(seq 1 90); do
  sleep 10
  STATUSES="$(aws ssm list-command-invocations --command-id "$CMD_ID" \
    --query 'CommandInvocations[].Status' --output text || true)"
  echo "  invocations: ${STATUSES:-<pending>}"
  [ -z "$STATUSES" ] && continue
  echo "$STATUSES" | grep -qiE 'Pending|InProgress|Delayed' && continue
  break
done

TOTAL="$(aws ssm list-command-invocations --command-id "$CMD_ID" \
  --query 'length(CommandInvocations)' --output text)"
if [ "$TOTAL" = "0" ]; then
  echo "No running instances tagged App=$APP_TAG were found." >&2
  revert
  exit 1
fi

FAILED=0
for IID in $(aws ssm list-command-invocations --command-id "$CMD_ID" \
  --query 'CommandInvocations[].InstanceId' --output text); do
  ST="$(aws ssm get-command-invocation --command-id "$CMD_ID" \
    --instance-id "$IID" --query 'Status' --output text)"
  echo "── $IID ($ST) ── stdout ──"
  aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$IID" \
    --query 'StandardOutputContent' --output text || true
  if [ "$ST" != "Success" ]; then
    FAILED=1
    echo "── $IID stderr ──"
    aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$IID" \
      --query 'StandardErrorContent' --output text || true
  fi
done

if [ "$FAILED" != "0" ]; then
  echo "Deploy failed on one or more instances." >&2
  revert
  exit 1
fi
echo "Deploy succeeded (in-place SSM): $TAG"
