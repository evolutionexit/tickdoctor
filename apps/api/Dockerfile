# syntax=docker/dockerfile:1.7
# Build from the repo root:  docker build -f apps/api/Dockerfile -t tickdoctor-api .
# Runtime env: DATABASE_URL, WEB_PUBLIC_URL, API_KEY_PEPPER, API_PORT (default 4000), TRUST_PROXY.
# CLI inside the container: docker compose exec api node dist/cli.js server:list

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# ---- build: full deps, bundle to dist/ ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @tickdoctor/api... --allow-build=esbuild
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @tickdoctor/api build

# ---- prod-deps: runtime dependencies only ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @tickdoctor/api --ignore-scripts

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/drizzle ./apps/api/drizzle
COPY --chown=node:node apps/api/package.json ./apps/api/
WORKDIR /app/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>r.json()).then(j=>process.exit(j.db?0:1)).catch(()=>process.exit(1))"
# Apply pending migrations, then start. exec so node receives SIGTERM directly.
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
