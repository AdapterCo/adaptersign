# syntax=docker/dockerfile:1
# Imagem única para API, worker e migrations (mesmo código; comandos distintos).
FROM node:22-bookworm-slim AS build
# OpenSSL: exigido pelos engines do Prisma (a imagem slim não o inclui).
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN if [ -f package-lock.json ]; then npm ci -w @adapter-sign/api --include-workspace-root=false; \
    else npm install -w @adapter-sign/api --include-workspace-root=false; fi
COPY apps/api apps/api
# `prisma generate` não conecta ao banco, mas exige DATABASE_URL definida (valor fictício de build).
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npm run build -w @adapter-sign/api \
 && npm prune --omit=dev -w @adapter-sign/api --include-workspace-root=false

FROM node:22-bookworm-slim AS runtime
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api ./apps/api
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
