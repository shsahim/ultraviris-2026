# syntax=docker/dockerfile:1

# Multi-stage build producing a small, self-contained Next.js runtime.
# Built for linux/arm64 (AWS Graviton) but works on amd64 too.

ARG NODE_VERSION=20-alpine

# ---- deps: install full dependencies (incl. native ssh2/mysql2) ----
FROM node:${NODE_VERSION} AS deps
# libc6-compat helps some native addons resolve on Alpine.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder: compile the standalone Next.js output ----
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal image that runs the standalone server ----
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# wget (busybox) is used by the container HEALTHCHECK.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone output bundles only the node_modules actually needed at runtime,
# including the native ssh2/mysql2 binaries traced by Next.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# Liveness check baked into the image; `docker run` inherits it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health/status || exit 1

CMD ["node", "server.js"]
