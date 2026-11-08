# syntax=docker/dockerfile:1
#
# Open Accountant (wilson) dashboard for a home server.
#
#   docker compose up -d                      # see docker-compose.yml
#   docker build -t wilson .                  # just the image
#
# Runs from source on Bun (not the compiled binary) so the on-device pieces
# that need native modules, onnxruntime-node and sharp for local embeddings and
# semantic search, keep working. All data lives in /data (HOME), a volume.

ARG BUN_VERSION=1.4.2
ARG NODE_VERSION=22

FROM oven/bun:${BUN_VERSION} AS bun

# ── 1. Dashboard UI (vite + npm, like CI) ───────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS ui
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# The UI imports shared helpers from src/, which import root packages.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src/dashboard/ui/package.json src/dashboard/ui/package-lock.json src/dashboard/ui/
RUN cd src/dashboard/ui && npm ci --no-audit --no-fund
COPY src ./src
RUN cd src/dashboard/ui && npm run build

# ── 2. Production dependencies ──────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN bun install --frozen-lockfile --production \
 # onnxruntime-node ships every platform's binaries; keep this one's.
 && find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 -type d ! -name linux -exec rm -rf {} + \
 && rm -rf /root/.bun/install/cache

# ── 3. Runtime ──────────────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim
LABEL org.opencontainers.image.title="Open Accountant (wilson)" \
      org.opencontainers.image.description="Privacy-first AI bookkeeper: the wilson dashboard for your home server" \
      org.opencontainers.image.source="https://github.com/openaccountant/wilson" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOME=/data \
    # LAN mode: the server refuses to bind here until dashboard login is on and an admin exists.
    WILSON_DASHBOARD_HOST=0.0.0.0 \
    # So on first boot, with no users yet, create the admin (random password, printed to the log).
    WILSON_ADMIN_BOOTSTRAP=generate

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock bunfig.toml tsconfig.json SOUL.md ./
COPY bin ./bin
COPY src ./src
COPY --from=ui /app/src/dashboard/ui/dist ./src/dashboard/ui/dist
COPY docker/entrypoint.sh /usr/local/bin/wilson-entrypoint
RUN mkdir -p /data && chown bun:bun /data

USER bun
VOLUME ["/data"]
EXPOSE 3141

# /api/auth/status needs no login and answers once the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3141/api/auth/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["wilson-entrypoint"]
CMD ["--dashboard", "--port", "3141"]
