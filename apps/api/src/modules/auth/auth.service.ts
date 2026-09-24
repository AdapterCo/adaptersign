import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ActorType, MemberRole, UserTokenPurpose } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { randomToken } from '../../common/crypto/crypto.util';
import { AppError, Errors } from '../../common/errors/app-error';
import { normalizeEmail, slugify } from '../../common/util/text';
import type { ClientInfo } from '../../common/http/client-info';
import { ROLE_PERMISSIONS, type AuthContext } from '../../common/auth/auth-context';
import type { AccessTokenClaims } from '../../common/auth/tokens';
import { RateLimitService } from '../../common/rate-limit/rate-limit';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { OutboxService, type EmittedEvent } from '../outbox/outbox.service';
import { DomainEvent } from '../outbox/domain-events';
import { PasswordService } from './password.service';
import type { RegisterDto } from './auth.dto';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTtlMs: number;
  refreshTtlMs: number;
}

const DAY = 24 * 3600 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly limiter: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ───────────── Cadastro ─────────────
  async register(dto: RegisterDto, client: ClientInfo): Promise<IssuedTokens> {
    const email = normalizeEmail(dto.email);
    const passwordHash = await this.passwords.hash(dto.password);
    const events: EmittedEvent[] = [];

    const tokens = await this.prisma.tx(async (tx) => {
      const exists = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (exists) throw Errors.conflict('EMAIL_IN_USE', 'Já existe uma conta com este e-mail.');

      const user = await tx.user.create({ data: { email, name: dto.name.trim(), passwordHash } });
      const slug = `${slugify(dto.organizationName) || 'org'}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)}`;
      const org = await tx.organization.create({ data: { name: dto.organizationName.trim(), slug } });
      await tx.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: MemberRole.OWNER } });

      const actor = { type: ActorType.USER, id: user.id };
      await this.audit.record(tx, { eventType: AuditEventType.ORGANIZATION_CREATED, actor, organizationId: org.id, ...client, metadata: { name: org.name } });
      await this.audit.record(tx, { eventType: AuditEventType.USER_REGISTERED, actor, organizationId: org.id, ...client });
      events.push(
        await this.outbox.emit(tx, {
          type: DomainEvent.USER_EMAIL_VERIFICATION_REQUESTED,
          organizationId: org.id,
          payload: { userId: user.id },
          requestId: client.requestId,
        }),
      );
      return this.createSession(tx, user.id, org.id, client);
    });
    await this.outbox.dispatch(events);
    return tokens;
  }

  // ───────────── Login ─────────────
  async login(emailInput: string, password: string, client: ClientInfo): Promise<IssuedTokens> {
    const email = normalizeEmail(emailInput);
    // Limite adicional por conta (além do limite por IP no guard).
    await this.limiter.consume('login', `email:${this.encryption.hashToken(email, 'rl')}`);

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, deletedAt: true, memberships: { orderBy: { createdAt: 'asc' }, take: 1, select: { organizationId: true } } },
    });
    const ok = await this.passwords.verify(user && !user.deletedAt ? user.passwordHash : null, password);
    const membership = user?.memberships[0];
    if (!user || user.deletedAt || !ok || !membership) {
      if (user && membership) {
        await this.audit.recordStandalone({
          eventType: AuditEventType.USER_LOGIN_FAILED,
          actor: { type: ActorType.USER, id: user.id },
          organizationId: membership.organizationId,
          ...client,
        });
      }
      throw new AppError('INVALID_CREDENTIALS', 'E-mail ou senha inválidos.', 401);
    }
    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await this.passwords.hash(password) } });
    }
    return this.prisma.tx(async (tx) => {
      await this.audit.record(tx, {
        eventType: AuditEventType.USER_LOGGED_IN,
        actor: { type: ActorType.USER, id: user.id },
        organizationId: membership.organizationId,
        ...client,
      });
      return this.createSession(tx, user.id, membership.organizationId, client);
    });
  }

  // ───────────── Sessões / tokens ─────────────
  private async createSession(tx: Tx, userId: string, organizationId: string, client: ClientInfo): Promise<IssuedTokens> {
    const refreshTtlMs = this.config.REFRESH_TOKEN_TTL_DAYS * DAY;
    const session = await tx.session.create({
      data: {
        userId,
        organizationId,
        ip: client.ip,
        userAgent: client.userAgent,
        expiresAt: new Date(Date.now() + refreshTtlMs),
      },
    });
    return this.issueTokens(tx, session.id, userId, organizationId, session.expiresAt);
  }

  private async issueTokens(tx: Tx, sessionId: string, userId: string, organizationId: string, sessionExpiresAt: Date): Promise<IssuedTokens> {
    const refreshToken = randomToken(32);
    const refreshExpires = new Date(Math.min(sessionExpiresAt.getTime(), Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY));
    await tx.refreshToken.create({
      data: { sessionId, tokenHash: this.encryption.hashToken(refreshToken, 'refresh'), expiresAt: refreshExpires },
    });
    const claims: AccessTokenClaims = { sub: userId, sid: sessionId, org: organizationId };
    const accessToken = await this.jwt.signAsync(claims, {
      algorithm: 'HS256',
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    });
    return {
      accessToken,
      refreshToken,
      accessTtlMs: this.config.ACCESS_TOKEN_TTL_SECONDS * 1000,
      refreshTtlMs: Math.max(0, refreshExpires.getTime() - Date.now()),
    };
  }

  /**
   * Rotação de refresh token com detecção de reutilização: se um token já usado
   * for apresentado novamente, a sessão inteira é revogada (possível roubo).
   */
  async refresh(rawToken: string, client: ClientInfo): Promise<IssuedTokens> {
    const tokenHash = this.encryption.hashToken(rawToken, 'refresh');
    const result = await this.prisma.tx(async (tx) => {
      const token = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { session: true },
      });
      if (!token) throw Errors.unauthenticated('Sessão inválida.');
      const { session } = token;
      if (session.revokedAt || session.expiresAt <= new Date() || token.expiresAt <= new Date()) {
        throw Errors.unauthenticated('Sessão expirada.');
      }
      const claimed = await tx.refreshToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count === 0) {
        await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'refresh_token_reuse' } });
        await this.audit.record(tx, {
          eventType: AuditEventType.REFRESH_TOKEN_REUSE_DETECTED,
          actor: { type: ActorType.USER, id: session.userId },
          organizationId: session.organizationId,
          ...client,
          metadata: { sessionId: session.id },
        });
        return { reuse: true as const };
      }
      await tx.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
      return { reuse: false as const, tokens: await this.issueTokens(tx, session.id, session.userId, session.organizationId, session.expiresAt) };
    });
    if (result.reuse) {
      this.logger.warn({ event: 'refresh_token_reuse_detected', request_id: client.requestId });
      throw Errors.unauthenticated('Sessão encerrada por segurança. Faça login novamente.');
    }
    return result.tokens;
  }

  async logout(auth: AuthContext, client: ClientInfo): Promise<void> {
    if (auth.kind !== 'user') return;
    await this.prisma.tx(async (tx) => {
      await tx.session.updateMany({ where: { id: auth.sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'logout' } });
      await this.audit.record(tx, {
        eventType: AuditEventType.USER_LOGGED_OUT,
        actor: { type: ActorType.USER, id: auth.userId },
        organizationId: auth.organizationId,
        ...client,
      });
    });
  }

  async revokeAllSessions(userId: string, organizationId: string, client: ClientInfo, reason: string, exceptSessionId?: string): Promise<number> {
    return this.prisma.tx(async (tx) => {
      const res = await tx.session.updateMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.SESSIONS_REVOKED,
        actor: { type: ActorType.USER, id: userId },
        organizationId,
        ...client,
        metadata: { count: res.count, reason },
      });
      return res.count;
    });
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
    return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
  }

  async revokeSession(userId: string, sessionId: string, organizationId: string, client: ClientInfo): Promise<void> {
    await this.prisma.tx(async (tx) => {
      const res = await tx.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'user_revoked' },
      });
      if (res.count === 0) throw Errors.notFound('SESSION_NOT_FOUND', 'Sessão não encontrada.');
      await this.audit.record(tx, {
        eventType: AuditEventType.SESSIONS_REVOKED,
        actor: { type: ActorType.USER, id: userId },
        organizationId,
        ...client,
        metadata: { count: 1, sessionId },
      });
    });
  }

  async switchOrganization(auth: AuthContext, organizationId: string): Promise<IssuedTokens> {
    if (auth.kind !== 'user') throw Errors.forbidden();
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: auth.userId } },
      select: { id: true },
    });
    if (!membership) throw Errors.forbidden('Você não é membro desta organização.');
    return this.prisma.tx(async (tx) => {
      const session = await tx.session.update({ where: { id: auth.sessionId }, data: { organizationId } });
      return this.issueTokens(tx, session.id, auth.userId, organizationId, session.expiresAt);
    });
  }

  // ───────────── E-mail / senha ─────────────
  async requestEmailVerification(auth: AuthContext, client: ClientInfo): Promise<void> {
    if (auth.kind !== 'user') throw Errors.forbidden();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { emailVerifiedAt: true } });
    if (user.emailVerifiedAt) return;
    await this.limiter.consume('password_reset', `verify:${auth.userId}`);
    const ev = await this.prisma.tx((tx) =>
      this.outbox.emit(tx, {
        type: DomainEvent.USER_EMAIL_VERIFICATION_REQUESTED,
        organizationId: auth.organizationId,
        payload: { userId: auth.userId },
        requestId: client.requestId,
      }),
    );
    await this.outbox.dispatch(ev);
  }

  async confirmEmail(rawToken: string, client: ClientInfo): Promise<void> {
    await this.prisma.tx(async (tx) => {
      const token = await this.consumeUserToken(tx, rawToken, UserTokenPurpose.EMAIL_VERIFICATION);
      const user = await tx.user.update({ where: { id: token.userId }, data: { emailVerifiedAt: new Date() }, include: { memberships: { take: 1 } } });
      await this.audit.record(tx, {
        eventType: AuditEventType.EMAIL_VERIFIED,
        actor: { type: ActorType.USER, id: user.id },
        organizationId: user.memberships[0]?.organizationId ?? null,
        ...client,
      });
    });
  }

  /** Sempre responde igual, exista ou não a conta (evita enumeração). */
  async forgotPassword(emailInput: string, client: ClientInfo): Promise<void> {
    const email = normalizeEmail(emailInput);
    await this.limiter.consume('password_reset', `email:${this.encryption.hashToken(email, 'rl')}`);
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, deletedAt: true, memberships: { take: 1, select: { organizationId: true } } },
    });
    if (!user || user.deletedAt) return;
    const orgId = user.memberships[0]?.organizationId ?? null;
    const ev = await this.prisma.tx(async (tx) => {
      await this.audit.record(tx, {
        eventType: AuditEventType.PASSWORD_RESET_REQUESTED,
        actor: { type: ActorType.USER, id: user.id },
        organizationId: orgId,
        ...client,
      });
      return this.outbox.emit(tx, {
        type: DomainEvent.USER_PASSWORD_RESET_REQUESTED,
        organizationId: orgId,
        payload: { userId: user.id },
        requestId: client.requestId,
      });
    });
    await this.outbox.dispatch(ev);
  }

  async resetPassword(rawToken: string, newPassword: string, client: ClientInfo): Promise<void> {
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.tx(async (tx) => {
      const token = await this.consumeUserToken(tx, rawToken, UserTokenPurpose.PASSWORD_RESET);
      const user = await tx.user.update({ where: { id: token.userId }, data: { passwordHash }, include: { memberships: { take: 1 } } });
      // Redefinição encerra todas as sessões.
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'password_reset' } });
      await this.audit.record(tx, {
        eventType: AuditEventType.PASSWORD_CHANGED,
        actor: { type: ActorType.USER, id: user.id },
        organizationId: user.memberships[0]?.organizationId ?? null,
        ...client,
        metadata: { via: 'reset' },
      });
    });
  }

  async changePassword(auth: AuthContext, current: string, next: string, client: ClientInfo): Promise<void> {
    if (auth.kind !== 'user') throw Errors.forbidden();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { passwordHash: true } });
    if (!(await this.passwords.verify(user.passwordHash, current))) {
      throw new AppError('INVALID_CREDENTIALS', 'Senha atual incorreta.', 401);
    }
    const passwordHash = await this.passwords.hash(next);
    await this.prisma.tx(async (tx) => {
      await tx.user.update({ where: { id: auth.userId }, data: { passwordHash } });
      await tx.session.updateMany({
        where: { userId: auth.userId, revokedAt: null, id: { not: auth.sessionId } },
        data: { revokedAt: new Date(), revokedReason: 'password_changed' },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.PASSWORD_CHANGED,
        actor: { type: ActorType.USER, id: auth.userId },
        organizationId: auth.organizationId,
        ...client,
        metadata: { via: 'change' },
      });
    });
  }

  private async consumeUserToken(tx: Tx, rawToken: string, purpose: UserTokenPurpose) {
    const tokenHash = this.encryption.hashToken(rawToken, `user_token:${purpose}`);
    const token = await tx.userToken.findUnique({ where: { tokenHash } });
    if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt <= new Date()) {
      throw Errors.validation('Link inválido ou expirado.');
    }
    const claimed = await tx.userToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count === 0) throw Errors.validation('Link inválido ou expirado.');
    return token;
  }

  async me(auth: AuthContext) {
    if (auth.kind !== 'user') throw Errors.forbidden();
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerifiedAt: true,
        isPlatformAdmin: true,
        memberships: { select: { role: true, organization: { select: { id: true, name: true, slug: true } } } },
      },
    });
    const current = user.memberships.find((m) => m.organization.id === auth.organizationId);
    return {
      user: { id: user.id, name: user.name, email: user.email, emailVerified: !!user.emailVerifiedAt, isPlatformAdmin: user.isPlatformAdmin },
      organization: current?.organization ?? null,
      role: auth.role,
      permissions: ROLE_PERMISSIONS[auth.role],
      organizations: user.memberships.map((m) => ({ ...m.organization, role: m.role })),
    };
  }
}
