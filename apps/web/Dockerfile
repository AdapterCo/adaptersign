# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN if [ -f package-lock.json ]; then npm ci -w @adapter-sign/web --include-workspace-root=false; \
    else npm install -w @adapter-sign/web --include-workspace-root=false; fi
# O package-lock gerado no Windows não registra os binários nativos Linux (npm/cli#4828).
# Instala-os na MESMA versão já resolvida, para a arquitetura do build (x64/arm64), num
# diretório isolado, e copia para node_modules sem alterar o restante da árvore.
# (Versões lidas direto do package.json no disco: alguns pacotes bloqueiam o subpath via "exports".)
RUN set -eu; \
    pkgv() { node -e "const fs=require('fs');for(const d of ['node_modules','apps/web/node_modules']){try{process.stdout.write(JSON.parse(fs.readFileSync(d+'/'+process.argv[1]+'/package.json','utf8')).version);process.exit(0)}catch(e){}}console.error('nao encontrado: '+process.argv[1]);process.exit(1)" "$1"; }; \
    ARCH="$(node -p process.arch)"; \
    LCSS="$(pkgv lightningcss)"; \
    OXIDE="$(pkgv @tailwindcss/oxide)"; \
    NEXT="$(pkgv next)"; \
    echo "binários nativos: linux-${ARCH} lightningcss@${LCSS} oxide@${OXIDE} next-swc@${NEXT}"; \
    mkdir -p /tmp/native && cd /tmp/native && npm init -y >/dev/null; \
    npm install --no-save --no-audit --no-fund \
      "lightningcss-linux-${ARCH}-gnu@${LCSS}" \
      "@tailwindcss/oxide-linux-${ARCH}-gnu@${OXIDE}" \
      "@next/swc-linux-${ARCH}-gnu@${NEXT}"; \
    rm -f /tmp/native/node_modules/.package-lock.json; \
    cp -r /tmp/native/node_modules/. /app/node_modules/; \
    rm -rf /tmp/native
COPY apps/web apps/web
# Rewrites e variáveis NEXT_PUBLIC_* são resolvidos no build.
ARG API_INTERNAL_URL=http://adaptersign-api:4000
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
