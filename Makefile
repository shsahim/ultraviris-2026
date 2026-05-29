# ── Configuration (override on the command line or via env) ──────────────────
AWS_REGION      ?= us-west-2
AWS_ACCOUNT_ID  ?= $(shell aws sts get-caller-identity --query Account --output text 2>/dev/null)
ECR_REPO        ?= ultraviris
IMAGE_TAG       ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo latest)
PLATFORM        ?= linux/arm64

REGISTRY        = $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
IMAGE           = $(REGISTRY)/$(ECR_REPO)
LOCAL_IMAGE     = ultraviris:local

.PHONY: help install test lint typecheck build buildx-setup ecr-login \
        build-arm64 push run stop logs ecr-create

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

test: ## Run unit tests
	npm test

lint: ## Lint
	npm run lint

typecheck: ## Type-check
	npx tsc --noEmit

build: ## Build a local image for the host architecture
	docker build -t $(LOCAL_IMAGE) .

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
	docker buildx build --platform $(PLATFORM) -t $(IMAGE):$(IMAGE_TAG) --load .

push: buildx-setup ecr-login ecr-create ## Build ARM64 and push to ECR (tag + latest)
	docker buildx build --platform $(PLATFORM) \
		-t $(IMAGE):$(IMAGE_TAG) \
		-t $(IMAGE):latest \
		--push .

run: ## Run the local image (expects .env.local for config)
	docker run --rm -p 3000:3000 --env-file .env.local --name ultraviris $(LOCAL_IMAGE)

stop: ## Stop the running container
	docker stop ultraviris || true

logs: ## Tail container logs
	docker logs -f ultraviris
