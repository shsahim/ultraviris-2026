#!/bin/bash
#
# Verifies that images in the S3 bucket are publicly reachable over HTTP using
# the same base URL the app serves them from (IMAGE_BASE_URL).
#
# Reads S3_BUCKET, AWS_REGION and IMAGE_BASE_URL from .env.local (or $ENV_FILE),
# lists a sample object via the AWS CLI, then curls its public URL and prints
# the HTTP status. Pass a specific object key as the first argument to test it
# instead of a random sample:
#
#   ./scripts/check-s3.sh
#   ./scripts/check-s3.sh images/brain_juice/foo.jpg
#
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

# Pull a single value from the dotenv file (everything after the first '=').
get_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

S3_BUCKET="$(get_env S3_BUCKET)"
AWS_REGION="$(get_env AWS_REGION)"
IMAGE_BASE_URL="$(get_env IMAGE_BASE_URL)"
AWS_REGION="${AWS_REGION:-us-west-2}"

if [[ -z "$S3_BUCKET" ]]; then
  echo "S3_BUCKET is not set in $ENV_FILE — nothing to check." >&2
  exit 1
fi

# Use the provided key, or sample the first object in the bucket.
KEY="${1:-}"
if [[ -z "$KEY" ]]; then
  echo "Listing a sample object from s3://$S3_BUCKET ..."
  # First real object, skipping .DS_Store noise. (No --max-items: that makes the
  # CLI emit a pagination token on its own line.)
  KEY="$(aws s3api list-objects-v2 \
    --bucket "$S3_BUCKET" --region "$AWS_REGION" \
    --query "Contents[?!contains(Key, '.DS_Store')].Key | [0]" \
    --output text 2>/dev/null | head -1 || true)"
  if [[ -z "$KEY" || "$KEY" == "None" ]]; then
    echo "Bucket has no usable objects or is not listable (check credentials / s3:ListBucket)." >&2
    exit 1
  fi
fi

# Build the URL the browser would request.
if [[ -n "$IMAGE_BASE_URL" ]]; then
  BASE="${IMAGE_BASE_URL%/}"
else
  BASE="https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com"
fi
URL="${BASE}/${KEY#/}"

echo "Object: $KEY"
echo "URL:    $URL"

STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$URL" || echo 000)"
echo "HTTP:   $STATUS"

case "$STATUS" in
  200)
    echo "OK — object is publicly reachable; images should render." ;;
  403)
    echo "FORBIDDEN — bucket/object is not publicly readable. Apply a public-read" >&2
    echo "policy (see scripts/setup-aws.sh) or serve via CloudFront/presigned URLs." >&2
    exit 1 ;;
  404)
    echo "NOT FOUND — the object key does not exist at that URL. Check that stored" >&2
    echo "File_Location values match the real object keys (incl. extensions)." >&2
    exit 1 ;;
  000)
    echo "Could not connect — check network / IMAGE_BASE_URL host." >&2
    exit 1 ;;
  *)
    echo "Unexpected status $STATUS." >&2
    exit 1 ;;
esac
