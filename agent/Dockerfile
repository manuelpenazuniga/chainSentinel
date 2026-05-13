# =============================================================================
# ChainSentinel Agent — Production Dockerfile (§5.2)
# =============================================================================
#
# Multi-stage build:
#   1. builder  — installs ALL deps (incl. dev), runs tsc, then prunes devDeps
#                 so the runtime stage gets a minimal node_modules.
#   2. runtime  — copies the pruned node_modules + dist from builder. No build
#                 tools, no source TypeScript.
#
# Native modules:
#   `better-sqlite3` is a native addon. On alpine it must be compiled from
#   source (no prebuilds for musl), which requires python3 + make + g++ in
#   the builder stage. The runtime stage only needs libstdc++ to load the
#   already-compiled .node file.
#
# Image size target: ~150MB (alpine base ~50MB + node ~80MB + app deps ~20MB).
#
# Build:
#   docker build -t chainsentinel-agent:latest -f agent/Dockerfile agent/
#
# Run:
#   docker run --rm \
#     -e RPC_URL=https://services.polkadothub-rpc.com/testnet \
#     -e CHAIN_ID=420420417 \
#     -e AGENT_PRIVATE_KEY=0x... \
#     -e VAULT_ADDRESS=0x... \
#     -e REGISTRY_ADDRESS=0x... \
#     -e GEMINI_API_KEY=AIza... \
#     -p 9090:9090 \
#     chainsentinel-agent:latest
# =============================================================================

# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install native build deps for better-sqlite3 (musl libc → no prebuilds).
# Pinned to alpine repo "stable" defaults; no network calls beyond apk.
RUN apk add --no-cache python3 make g++

# Lockfile-first install for cache stability.
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci

# Compile TypeScript. tsconfig.json emits to ./dist with .d.ts + sourcemaps.
COPY src ./src
RUN npx tsc

# Drop devDependencies so the runtime image is minimal.
# (Keeps node_modules with ONLY runtime deps.)
RUN npm prune --omit=dev

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Runtime deps:
#   - libstdc++  → required by better-sqlite3's compiled .node module
#   - wget       → used by HEALTHCHECK to hit /health
#   - tini       → minimal init that reaps zombies and forwards SIGTERM
#                  (without it, Node receives SIGKILL on `docker stop`,
#                   skipping our shutdown handler in index.ts)
RUN apk add --no-cache libstdc++ wget tini

# Copy artifacts from builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Run as a non-root user (defense in depth).
# `node` user comes pre-created by the official node:alpine image (uid 1000).
USER node

ENV NODE_ENV=production \
    METRICS_PORT=9090 \
    POLL_INTERVAL_MS=6000

EXPOSE 9090

# Liveness probe — hits the metrics module's /health endpoint (always 200 ok
# while the process is alive). 30s interval; container is unhealthy after 3
# consecutive failures (~90s of downtime).
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:9090/health || exit 1

# Use tini to forward SIGTERM cleanly (so index.ts shutdown handler runs).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
