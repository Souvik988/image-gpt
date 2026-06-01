# syntax=docker/dockerfile:1.6
#
# Multi-stage build for the relay-server.
# Implements R25.1, R25.2 (relay container on port 3001) and R25.3 (HEALTHCHECK).
#
# Build context MUST be the workspace root, e.g.:
#   docker build -f relay-server/Dockerfile -t kiro-gpt-bridge-relay .
#
# Only `shared/` and `relay-server/` are copied into the image; the other
# workspaces (`browser-agent/`, `kiro-extension/`, `mcp-server/`) are not
# needed by the relay and are excluded via the .dockerignore.

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root manifests first so the npm install layer caches well across
# source-only changes inside shared/ or relay-server/.
COPY package.json package-lock.json tsconfig.base.json ./

# Copy only the workspaces the relay depends on.
COPY shared ./shared
COPY relay-server ./relay-server

# Install ALL workspace deps (dev + prod). npm ci honours workspaces and
# wires up the cross-package symlinks under node_modules/@kiro-gpt-bridge/*.
# We need devDependencies here because the build step uses `tsc`.
RUN npm ci --no-audit --no-fund

# Build shared first (relay-server imports from it), then relay-server.
RUN npm --workspace @kiro-gpt-bridge/shared run build \
 && npm --workspace @kiro-gpt-bridge/relay-server run build

# Strip dev dependencies from the hoisted node_modules so the runner stage
# picks up a slim production tree. Workspace symlinks are preserved.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: runner
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runner

LABEL org.opencontainers.image.title="kiro-gpt-bridge-relay"
LABEL org.opencontainers.image.source="https://github.com/<placeholder>/kiro-gpt-bridge"
LABEL org.opencontainers.image.description="Relay server for the KIRO-GPT Bridge."

WORKDIR /app

# Non-root user (R25 hardening best practice).
RUN addgroup -S relay && adduser -S relay -G relay

# Copy the production node_modules and only the artifacts the relay needs at
# runtime. The hoisted node_modules contains the symlink
# node_modules/@kiro-gpt-bridge/shared -> ../../shared, so `shared/dist` and
# `shared/package.json` must also be present at the same workspace layout.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/relay-server/package.json ./relay-server/package.json
COPY --from=builder /app/relay-server/dist ./relay-server/dist

RUN chown -R relay:relay /app

USER relay

EXPOSE 3001

# busybox `wget` on alpine returns non-zero on any non-2xx, which is the
# behaviour we want for HEALTHCHECK (R25.3).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O- http://localhost:3001/health || exit 1

CMD ["node", "relay-server/dist/index.js"]
