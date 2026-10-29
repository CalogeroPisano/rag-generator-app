# syntax=docker/dockerfile:1.7
# Multi-stage build: web, worker and migrate images from one build stage.
# Runtime images contain only bundled JavaScript (no node_modules) plus the
# collected third-party licenses.

ARG NODE_IMAGE=node:24.22.1-trixie-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY adapters/inbound/web/package.json adapters/inbound/web/
COPY adapters/inbound/worker/package.json adapters/inbound/worker/
COPY packages/core/package.json packages/core/
COPY adapters/outbound/postgres/package.json adapters/outbound/postgres/
COPY adapters/outbound/openai/package.json adapters/outbound/openai/
COPY adapters/outbound/ollama/package.json adapters/outbound/ollama/
COPY adapters/outbound/filesystem/package.json adapters/outbound/filesystem/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @code-to-rag/web build \
 && pnpm --filter @code-to-rag/worker build \
 && node scripts/check-licenses.mjs

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Shared data volume (uploads, work areas): owned by the unprivileged user, so a
# freshly created named volume inherits this ownership.
RUN mkdir -p /data && chown node:node /data
USER node

FROM runtime AS web
COPY --from=build --chown=node:node /repo/adapters/inbound/web/dist ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/favicon.ico').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "serve.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /repo/adapters/inbound/worker/dist ./
ENV GRAMMARS_DIR=/app/grammars
CMD ["node", "main.js"]

FROM runtime AS migrate
COPY --from=build --chown=node:node /repo/adapters/inbound/worker/dist ./
COPY --from=build --chown=node:node /repo/adapters/outbound/postgres/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
CMD ["node", "migrate.js"]
