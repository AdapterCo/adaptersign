import type { NextFunction, Request, Response } from 'express';
import { ACCESS_COOKIE, REFRESH_COOKIE, SIGN_SESSION_COOKIE } from '../auth/tokens';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Proteção CSRF para requisições autenticadas por cookie (defesa em profundidade além
 * de SameSite=Lax): métodos que alteram estado exigem Origin/Referer de origem permitida.
 * Requisições com API key (Authorization: Bearer) não usam cookies e não são afetadas.
 */
export function csrfOriginCheck(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const usesCookieAuth = !!(cookies[ACCESS_COOKIE] || cookies[REFRESH_COOKIE] || cookies[SIGN_SESSION_COOKIE]);
    if (!usesCookieAuth || req.headers.authorization) return next();

    let origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (!origin && typeof req.headers.referer === 'string') {
      try {
        origin = new URL(req.headers.referer).origin;
      } catch {
        origin = null;
      }
    }
    if (origin && allowed.has(origin)) return next();
    res.status(403).json({
      error: { code: 'CSRF_ORIGIN_REJECTED', message: 'Origem da requisição não permitida.', request_id: (req as Request & { id?: string }).id ?? null },
    });
  };
}
