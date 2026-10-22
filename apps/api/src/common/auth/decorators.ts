import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext, PermissionValue } from './auth-context';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_PERMISSION = 'auth:permission';
export const USER_ONLY = 'auth:user_only';
export const PLATFORM_ADMIN = 'auth:platform_admin';
export const ALLOW_WITHOUT_PLAN = 'auth:allow_without_plan';

/** Rota sem autenticação de usuário (páginas públicas, assinatura, validação). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const RequirePermission = (permission: PermissionValue) => SetMetadata(REQUIRED_PERMISSION, permission);
/** Rota proibida para API keys (gestão de conta, sessões, chaves). */
export const UserOnly = () => SetMetadata(USER_ONLY, true);
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN, true);
/** Ações liberadas sem plano pago (conta, contratação, dados da empresa). */
export const AllowWithoutPlan = () => SetMetadata(ALLOW_WITHOUT_PLAN, true);

export type AuthedRequest = Request & { auth?: AuthContext; id?: string };

export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('CurrentAuth usado em rota sem autenticação');
  return req.auth;
});
