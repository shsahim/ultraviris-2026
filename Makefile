# ── Configuration (override on the command line or via env) ──────────────────
AWS_REGION      ?= us-west-2
AWS_ACCOUNT_ID  ?= $(shell aws sts get-caller-identity --query Account --output text 2>/dev/null)
ECR_REPO        ?= ultraviris
# Human-readable version derived from git: nearest tag + commits-ahead + short
# sha, with a "-dirty" suffix when the working tree has uncommitted changes
# (e.g. v1.2.0-3-g1a2b3c4-dirty, or just the sha if there are no tags yet).
VERSION         ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
GIT_SHA         ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
IMAGE_TAG       ?= $(VERSION)
PLATFORM        ?= linux/arm64

REGISTRY        = $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
IMAGE           = $(REGISTRY)/$(ECR_REPO)
LOCAL_IMAGE     = ultraviris:local

# Host path to the SSH private key (PEM) used for the DB tunnel. Mounted into
# the container by `run-local`. Override on the command line if it moves.
SSH_KEY         ?= /Users/ssahim/Documents/Documents - Spencer’s MacBook Pro/Pem files/Ultraviris_new.pem

# Host AWS profile dir. If it has a credentials file, `run-local` mounts it so
# the container can reach S3/SES without pasting keys into .env.local. (Env
# credentials in .env.local still take precedence when present.)
AWS_DIR         ?= $(HOME)/.aws
AWS_MOUNT       := $(if $(wildcard $(AWS_DIR)/credentials),-v "$(AWS_DIR):/home/nextjs/.aws:ro" -e HOME=/home/nextjs,)

# GitHub issue reporter (admin "Report an issue"). Local/dev targets pull a token
# from the gh CLI into .env.local. Production receives it — and every other
# secret — via `make ship`, which validates and syncs .env.local into the
# ENV_SECRET Secrets Manager secret (see scripts/sync-secrets.mts).
GITHUB_ISSUE_REPO ?= shsahim/ultraviris-2026
ENV_SECRET        ?= ultraviris/env

.PHONY: help version install test lint typecheck build buildx-setup ecr-login \
        build-arm64 push run run-local stop logs ecr-create check-s3 \
        github-token-local sync-secrets push-github-env \
        fix-file-locations-s3 fix-active-projects launch-ec2 setup-aws setup-alb-asg dns dns-create-role ship deploy

# EC2 tag the deploy targets/pipeline aim at, and the on-instance deploy script.
APP_TAG         ?= ultraviris
DEPLOY_SCRIPT   ?= /opt/ultraviris/deploy.sh
IMAGE_TAG_PARAM ?= /ultraviris/image-tag
# Auto Scaling Group the zero-downtime rollout refreshes (matches CI + setup-alb-asg).
ASG_NAME        ?= ultraviris-asg
# Tag a manual deploy ships/rolls out. Defaults to the current git short sha so
# it matches what CI would push for this commit.
DEPLOY_TAG      ?= $(GIT_SHA)
ROLLOUT_ENV     = AWS_REGION="$(AWS_REGION)" APP_TAG="$(APP_TAG)" ASG_NAME="$(ASG_NAME)" \
                  IMAGE_TAG_PARAM="$(IMAGE_TAG_PARAM)" DEPLOY_SCRIPT="$(DEPLOY_SCRIPT)"

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

version: ## Print the version that image builds will be tagged with
	@echo "$(VERSION) (sha $(GIT_SHA))"

install: ## Install dependencies
	npm ci

test: ## Run unit tests
	npm test

lint: ## Lint
	npm run lint

typecheck: ## Type-check
	npx tsc --noEmit

build: github-token-local ## Build a local image for the host arch (tags :$(VERSION), :local, :latest)
	docker build \
		--label org.opencontainers.image.version=$(VERSION) \
		--label org.opencontainers.image.revision=$(GIT_SHA) \
		-t ultraviris:$(VERSION) \
		-t $(LOCAL_IMAGE) \
		-t ultraviris:latest \
		.
	@echo "Built ultraviris:$(VERSION) (also tagged :local and :latest)"

buildx-setup: ## Create/boot a buildx builder with QEMU for cross-arch builds
	docker run --privileged --rm tonistiigi/binfmt --install all
	docker buildx inspect ultraviris-builder >/dev/null 2>&1 \
		|| docker buildx create --name ultraviris-builder --use
	docker buildx inspect --bootstrap

ecr-create: ## Create the ECR repository if it doesn't exist
	aws ecr describe-repositories --repository-names $(ECR_REPO) --region $(AWS_REGION) >/dev/null 2>&1 \
		|| aws ecr create-repository --repository-name $(ECR_REPO) --region $(AWS_REGION)

ecr-login: ## Authenticate Docker to ECR
	aws ecr get-login-password --region $(AWS_REGION) \
		| docker login --username AWS --password-stdin $(REGISTRY)

build-arm64: buildx-setup ## Build the ARM64 image locally (loads into docker)
	docker buildx build --platform $(PLATFORM) \
		--label org.opencontainers.image.version=$(VERSION) \
		--label org.opencontainers.image.revision=$(GIT_SHA) \
		-t $(IMAGE):$(IMAGE_TAG) --load .

push: buildx-setup ecr-login ecr-create ## Build ARM64 and push to ECR (version tag + latest)
	docker buildx build --platform $(PLATFORM) \
		--label org.opencontainers.image.version=$(VERSION) \
		--label org.opencontainers.image.revision=$(GIT_SHA) \
		-t $(IMAGE):$(IMAGE_TAG) \
		-t $(IMAGE):latest \
		--push .

run: github-token-local ## Run the local image (expects .env.local for config)
	@if [ -f .env.local ] && grep -qE '^[[:space:]]*SSH_HOST[[:space:]]*=[[:space:]]*[^[:space:]]' .env.local; then \
		echo "WARNING: .env.local sets SSH_HOST, so the DB needs the SSH tunnel."; \
		echo "         'make run' does NOT mount the SSH key, so DB connections will fail."; \
		echo "         Use 'make run-local' instead (mounts the key + AWS creds)."; \
	fi
	docker run --rm -p 3000:3000 --env-file .env.local --name ultraviris $(LOCAL_IMAGE)

run-local: github-token-local ## Run locally with .env.local and the SSH key mounted into the container
	@test -f "$(SSH_KEY)" || { echo "SSH key not found: $(SSH_KEY)"; echo "Set it with: make run-local SSH_KEY=/path/to/key.pem"; exit 1; }
	docker run --rm -p 3000:3000 \
		--env-file .env.local \
		-e SSH_PRIVATE_KEY_PATH=/run/ssh_key.pem \
		-v "$(SSH_KEY):/run/ssh_key.pem:ro" \
		$(AWS_MOUNT) \
		--name ultraviris $(LOCAL_IMAGE)

stop: ## Stop the running container
	docker stop ultraviris || true

logs: ## Tail container logs
	docker logs -f ultraviris

github-token-local: ## Sync GITHUB_TOKEN (via gh) + GITHUB_ISSUE_REPO into .env.local
	@GITHUB_ISSUE_REPO="$(GITHUB_ISSUE_REPO)" ./scripts/github-token.sh env-local

sync-secrets: ## Preview the .env.local -> $(ENV_SECRET) secret sync (dry-run; validates, no writes)
	@AWS_REGION="$(AWS_REGION)" ENV_SECRET="$(ENV_SECRET)" npm run --silent sync-secrets

push-github-env: ## Push .env.local into APP_* GitHub Secrets/Variables (source for the CI deploy)
	@npm run --silent push-github-env

check-s3: ## Verify S3 images are publicly reachable (optionally KEY=images/...)
	@./scripts/check-s3.sh $(KEY)

fix-file-locations-s3: ## Align DB File_Location with S3 (dry-run default; APPLY=1 to write, TABLE=name)
	@APPLY="$(APPLY)" TABLE="$(TABLE)"; \
	ARGS=""; \
	[ "$$APPLY" = "1" ] && ARGS="$$ARGS --apply"; \
	[ -n "$$TABLE" ] && ARGS="$$ARGS --table $$TABLE"; \
	npm run fix-file-locations-s3 -- $$ARGS

fix-active-projects: ## Fix active_projects table_name links (dry-run default; APPLY=1 to write)
	@APPLY="$(APPLY)"; \
	ARGS=""; \
	[ "$$APPLY" = "1" ] && ARGS="$$ARGS --apply"; \
	npm run fix-active-projects -- $$ARGS

launch-ec2: ## Provision a single tagged EC2 instance (simple/no ALB; see scripts/launch-ec2.sh)
	@./scripts/launch-ec2.sh

setup-aws: ## Provision base AWS resources: ECR, IAM (OIDC + EC2 role), Secrets, S3 (see scripts/setup-aws.sh)
	@./scripts/setup-aws.sh

setup-alb-asg: ## Provision ALB + ASG + HTTPS (ACM) for the domain (see scripts/setup-alb-asg.sh)
	@./scripts/setup-alb-asg.sh

dns-create-role: ## Create the cross-account Route 53 role (run with DNS-account creds, e.g. AWS_PROFILE=network)
	@./scripts/setup-dns.sh create-role

dns: ## Upsert ACM validation + apex ALIAS in the DNS account (run with app-account creds)
	@./scripts/setup-dns.sh apply

ship: buildx-setup ecr-login ecr-create ## Validate+sync secrets, build+push, and roll out (rolls the secret back if the deploy is unhealthy)
	@set -e; \
	TAG="$${TAG:-$(DEPLOY_TAG)}"; \
	echo "== Validating + syncing secrets (.env.local -> $(ENV_SECRET)) =="; \
	AWS_REGION="$(AWS_REGION)" ENV_SECRET="$(ENV_SECRET)" npm run --silent sync-secrets -- --apply; \
	echo "== Building and pushing $(IMAGE):$$TAG (+ :latest) =="; \
	if docker buildx build --platform $(PLATFORM) \
		--label org.opencontainers.image.version=$(VERSION) \
		--label org.opencontainers.image.revision=$(GIT_SHA) \
		-t $(IMAGE):$$TAG \
		-t $(IMAGE):latest \
		--push . \
		&& $(ROLLOUT_ENV) ./scripts/rollout.sh "$$TAG"; then \
		echo "Ship complete: $$TAG"; \
	else \
		echo "!! Build or rollout failed after the secret update — rolling the secret back"; \
		AWS_REGION="$(AWS_REGION)" ENV_SECRET="$(ENV_SECRET)" npm run --silent sync-secrets -- --rollback || true; \
		exit 1; \
	fi

deploy: ## Roll out an already-pushed tag (TAG=<sha|latest>, default: git short sha); no build
	@TAG="$${TAG:-$(DEPLOY_TAG)}"; \
	$(ROLLOUT_ENV) ./scripts/rollout.sh "$$TAG"
