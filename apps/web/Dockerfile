# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN if [ -f package-lock.json ]; then npm ci -w @adapter-sign/web --include-workspace-root=false; \
    else npm install -w @adapter-sign/web --include-workspace-root=false; fi
COPY apps/web apps/web
# Rewrites e variáveis NEXT_PUBLIC_* são resolvidos no build.
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_BRAND_NAME="Adapter Sign"
ENV API_INTERNAL_URL=$API_INTERNAL_URL \
    NEXT_PUBLIC_BRAND_NAME=$NEXT_PUBLIC_BRAND_NAME \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @adapter-sign/web

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/verify').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
