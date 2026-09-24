import path from 'node:path';
import type { NextConfig } from 'next';

// A API é servida na MESMA origem (/api/v1) — cookies HttpOnly first-party, sem CORS.
// Em produção o reverse proxy (Nginx/Traefik) encaminha /api diretamente ao backend;
// este rewrite cobre desenvolvimento e implantações sem proxy dedicado.
// Observação: rewrites são resolvidos no build; API_INTERNAL_URL deve estar definido no build.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const csp = [
  "default-src 'self'",
  // Next.js injeta scripts inline de hidratação.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  output: 'standalone',
  // Monorepo: raiz explícita para o tracing (standalone em .next/standalone/apps/web/server.js).
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiInternalUrl}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
