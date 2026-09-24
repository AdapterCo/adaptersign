import type { CookieOptions } from 'express';
import type { AppConfig } from '../../config/config';

export const ACCESS_COOKIE = 'ads_at';
export const REFRESH_COOKIE = 'ads_rt';
export const SIGN_SESSION_COOKIE = 'ads_sign';
export const API_KEY_PREFIX = 'ads_';

export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // session id
  org: string; // organization id (informativo; o guard revalida via sessão)
}

/** Cookies HttpOnly + Secure + SameSite=Lax (tokens nunca acessíveis a JS / localStorage). */
export function cookieOptions(config: AppConfig, path: string, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path,
    domain: config.COOKIE_DOMAIN || undefined,
    maxAge: maxAgeMs,
  };
}
