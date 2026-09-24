import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { EncryptionService } from '../crypto/encryption.service';
import { AppError, Errors } from '../errors/app-error';
import { hasPermission, type AuthContext, type PermissionValue } from './auth-context';
import { IS_PUBLIC, PLATFORM_ADMIN, REQUIRED_PERMISSION, USER_ONLY, type AuthedRequest } from './decorators';
import { ACCESS_COOKIE, API_KEY_PREFIX, type AccessTokenClaims } from './tokens';
import { PlansService } from '../../modules/billing/plans.service';
import { UsageService } from '../../modules/billing/usage.service';
import { UsageMetric } from '../../generated/prisma/client';

/**
 * Guard global. Resolve a identidade (cookie de sessão OU API key) e o tenant
 * EXCLUSIVAMENTE no backend: organization_id nunca vem do cliente.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    @Inject(PlansService) private readonly plans: PlansService,
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = await this.authenticate(req);
    req.auth = auth;

    if (this.reflector.getAllAndOverride<boolean>(USER_ONLY, targets) && auth.kind !== 'user') {
      throw Errors.forbidden('Esta operação não está disponível para API keys.');
    }
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN, targets)) {
      if (auth.kind !== 'user' || !auth.isPlatformAdmin) throw Errors.forbidden();
    }
    const permission = this.reflector.getAllAndOverride<PermissionValue | undefined>(REQUIRED_PERMISSION, targets);
    if (permission && !hasPermission(auth.role, permission)) throw Errors.forbidden();
    return true;
  }

  private async authenticate(req: AuthedRequest): Promise<AuthContext> {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      if (token.startsWith(API_KEY_PREFIX)) return this.authenticateApiKey(token);
      throw Errors.unauthenticated('Credencial inválida.');
    }
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    const access = cookies?.[ACCESS_COOKIE];
    if (!access) throw Errors.unauthenticated();
    return this.authenticateSession(access);
  }

  private async authenticateSession(token: string): Promise<AuthContext> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, { algorithms: ['HS256'] });
    } catch {
      throw new AppError('SESSION_EXPIRED', 'Sessão expirada.', 401);
    }
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: { id: true, userId: true, organizationId: true, revokedAt: true, expiresAt: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.userId !== claims.sub) {
      throw Errors.unauthenticated('Sessão encerrada.');
    }
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: session.organizationId, userId: session.userId } },
      select: { role: true, user: { select: { deletedAt: true, isPlatformAdmin: true } }, organization: { select: { deletedAt: true } } },
    });
    if (!membership || membership.user.deletedAt || membership.organization.deletedAt) {
      throw Errors.unauthenticated('Acesso à organização não disponível.');
    }
    return {
      kind: 'user',
      userId: session.userId,
      organizationId: session.organizationId,
      role: membership.role,
      sessionId: session.id,
      isPlatformAdmin: membership.user.isPlatformAdmin,
    };
  }

  private async authenticateApiKey(rawKey: string): Promise<AuthContext> {
    const keyHash = this.encryption.hashToken(rawKey, 'api_key');
    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      select: { id: true, organizationId: true, role: true, revokedAt: true, expiresAt: true, lastUsedAt: true },
    });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) {
      throw Errors.unauthenticated('API key inválida ou revogada.');
    }
    const plan = await this.plans.planForOrganization(key.organizationId);
    if (!plan.apiAccess) throw Errors.planLimit('O plano atual não inclui acesso à API.');

    const now = new Date();
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
      await this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
    }
    await this.usage.increment(this.prisma, key.organizationId, UsageMetric.API_REQUESTS, 1);
    return { kind: 'api_key', apiKeyId: key.id, organizationId: key.organizationId, role: key.role };
  }
}
