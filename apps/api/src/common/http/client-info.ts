import type { Request } from 'express';

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * IP e user agent são registrados como evidência auxiliar — NUNCA como prova de identidade.
 * `req.ip` respeita `trust proxy` (configurado por TRUST_PROXY_HOPS).
 */
export function clientInfo(req: Request): ClientInfo {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
    requestId: ((req as Request & { id?: unknown }).id as string | undefined) ?? null,
  };
}
