import { Inject, Injectable } from '@nestjs/common';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from '../../infra/whatsapp/whatsapp.provider';
import { randomUUID } from 'node:crypto';
import { ActorType, AuthMethod, SignerStatus, type Signer } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { randomNumericCode, safeEqual } from '../../common/crypto/crypto.util';
import { AppError, Errors } from '../../common/errors/app-error';
import { maskEmail } from '../../common/util/mask';
import { maskPhone } from '../../common/util/phone';
import type { ClientInfo } from '../../common/http/client-info';
import { RateLimitService } from '../../common/rate-limit/rate-limit';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { OutboxService } from '../outbox/outbox.service';
import { DomainEvent } from '../outbox/domain-events';
import { NotificationsService } from '../notifications/notifications.service';
import { signerSourcesFor } from '../envelopes/envelope-state';
import { defaultOtpChannel, otpChannels, requiresChallenge, type OtpChannel } from './auth-methods';

const OTP_LENGTH = 6;

export interface SessionRef {
  id: string;
  signerId: string;
  envelopeId: string;
  authenticatedAt: Date | null;
  linkChannel?: string | null;
}

/**
 * OTP por e-mail ou WhatsApp (mesmo canal do link, por padrão): código de CSPRNG, somente HMAC persistido, validade curta,
 * limite de tentativas, cooldown, rate limiting e uso único. Nunca registrado em logs.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly limiter: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
  ) {}

  private hashCode(challengeId: string, code: string): string {
    return this.encryption.hashToken(code, `otp:${challengeId}`);
  }

  async request(session: SessionRef, signer: Signer, client: ClientInfo, requested?: OtpChannel) {
    if (!requiresChallenge(signer.authMethod)) throw Errors.unprocessable('OTP_NOT_REQUIRED', 'Este signatário não utiliza OTP.');
    if (session.authenticatedAt) throw Errors.conflict('ALREADY_AUTHENTICATED', 'Sessão já autenticada.');
    const channels = otpChannels(signer, this.whatsapp.enabled);
    if (requested && !channels.includes(requested)) throw Errors.validation('Canal de envio do código indisponível para este signatário.');
    const channel = requested ?? defaultOtpChannel(channels, session.linkChannel);
    if (!channel) throw Errors.unprocessable('AUTH_METHOD_UNAVAILABLE', 'Envio do código por WhatsApp indisponível no momento.');
    const method = channel === 'WHATSAPP' ? AuthMethod.WHATSAPP_OTP : AuthMethod.EMAIL_OTP;
    await this.limiter.consume('otp_request_signer', signer.id);

    const last = await this.prisma.authenticationChallenge.findFirst({
      where: { signerId: signer.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const cooldownMs = this.config.OTP_RESEND_COOLDOWN_SECONDS * 1000;
    if (last && Date.now() - last.createdAt.getTime() < cooldownMs) {
      const wait = Math.ceil((cooldownMs - (Date.now() - last.createdAt.getTime())) / 1000);
      throw new AppError('OTP_COOLDOWN', `Aguarde ${wait}s para solicitar um novo código.`, 429, { retry_after_seconds: wait });
    }

    const code = randomNumericCode(OTP_LENGTH);
    const challengeId = randomUUID();
    const expiresAt = new Date(Date.now() + this.config.OTP_TTL_SECONDS * 1000);
    const destinationMasked = channel === 'WHATSAPP' ? (maskPhone(signer.phone) ?? '') : maskEmail(signer.email);

    const notificationId = await this.prisma.tx(async (tx) => {
      // Invalida desafios anteriores ainda ativos (apenas o último código vale).
      await tx.authenticationChallenge.updateMany({
        where: { signerId: signer.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
      await tx.authenticationChallenge.create({
        data: {
          id: challengeId,
          signerId: signer.id,
          signatureSessionId: session.id,
          method,
          codeHash: this.hashCode(challengeId, code),
          destinationMasked,
          maxAttempts: this.config.OTP_MAX_ATTEMPTS,
          expiresAt,
        },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.OTP_REQUESTED,
        actor: { type: ActorType.SIGNER, id: signer.id },
        organizationId: signer.organizationId,
        envelopeId: signer.envelopeId,
        signerId: signer.id,
        ...client,
        metadata: { challengeId, method, channel, destination: destinationMasked, expiresAt },
      });
      return this.notifications.create(tx, {
        template: 'signer_otp',
        channel,
        recipient: channel === 'WHATSAPP' ? signer.phone! : signer.email,
        dedupeKey: `otp:${challengeId}`,
        organizationId: signer.organizationId,
        envelopeId: signer.envelopeId,
        signerId: signer.id,
        data: { signerId: signer.id, challengeId },
      });
    });
    // O código segue para o worker apenas cifrado (AES-GCM) no payload do job.
    if (notificationId) await this.notifications.dispatch(notificationId, this.encryption.encrypt(code));
    return { destination: destinationMasked, channel, expiresAt, resendAvailableAt: new Date(Date.now() + cooldownMs) };
  }

  async verify(session: SessionRef, signer: Signer, code: string, client: ClientInfo): Promise<void> {
    if (session.authenticatedAt) return;
    const normalized = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) throw Errors.validation('Código inválido.');

    const result = await this.prisma.tx(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "authentication_challenges"
        WHERE "signer_id" = ${signer.id}::uuid AND "signature_session_id" = ${session.id}::uuid
          AND "consumed_at" IS NULL AND "invalidated_at" IS NULL
        ORDER BY "created_at" DESC LIMIT 1 FOR UPDATE`;
      if (rows.length === 0) return { ok: false as const, reason: 'NO_CHALLENGE' as const };
      const ch = await tx.authenticationChallenge.findUniqueOrThrow({ where: { id: rows[0].id } });
      const actor = { type: ActorType.SIGNER, id: signer.id };
      const base = { actor, organizationId: signer.organizationId, envelopeId: signer.envelopeId, signerId: signer.id, ...client };
      if (ch.expiresAt <= new Date()) {
        await tx.authenticationChallenge.update({ where: { id: ch.id }, data: { invalidatedAt: new Date() } });
        return { ok: false as const, reason: 'EXPIRED' as const };
      }
      if (ch.attempts >= ch.maxAttempts) {
        await tx.authenticationChallenge.update({ where: { id: ch.id }, data: { invalidatedAt: new Date() } });
        return { ok: false as const, reason: 'LOCKED' as const };
      }
      const matches = safeEqual(this.hashCode(ch.id, normalized), ch.codeHash);
      if (!matches) {
        const attempts = ch.attempts + 1;
        await tx.authenticationChallenge.update({
          where: { id: ch.id },
          data: { attempts, ...(attempts >= ch.maxAttempts ? { invalidatedAt: new Date() } : {}) },
        });
        await this.audit.record(tx, { ...base, eventType: AuditEventType.OTP_FAILED, metadata: { challengeId: ch.id, attempts, maxAttempts: ch.maxAttempts } });
        return { ok: false as const, reason: attempts >= ch.maxAttempts ? ('LOCKED' as const) : ('MISMATCH' as const), remaining: ch.maxAttempts - attempts };
      }
      const now = new Date();
      const consumed = await tx.authenticationChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: now } });
      if (consumed.count === 0) return { ok: false as const, reason: 'NO_CHALLENGE' as const };
      await tx.signatureSession.update({ where: { id: session.id }, data: { authenticatedAt: now, authMethod: ch.method } });
      await tx.signer.updateMany({
        where: { id: signer.id, status: { in: signerSourcesFor(SignerStatus.AUTHENTICATED) } },
        data: { status: SignerStatus.AUTHENTICATED, authenticatedAt: now },
      });
      await this.audit.record(tx, { ...base, eventType: AuditEventType.OTP_VALIDATED, occurredAt: now, metadata: { challengeId: ch.id, attempts: ch.attempts + 1 } });
      await this.audit.record(tx, {
        ...base,
        eventType: AuditEventType.SIGNER_AUTHENTICATED,
        occurredAt: now,
        metadata: { method: ch.method, challengeId: ch.id, sessionId: session.id },
      });
      const ev = await this.outbox.emit(tx, {
        type: DomainEvent.SIGNER_AUTHENTICATED,
        organizationId: signer.organizationId,
        payload: { envelopeId: signer.envelopeId, signerId: signer.id },
        requestId: client.requestId,
      });
      return { ok: true as const, ev };
    });

    if (result.ok) {
      await this.outbox.dispatch(result.ev);
      return;
    }
    switch (result.reason) {
      case 'EXPIRED':
        throw Errors.unprocessable('OTP_EXPIRED', 'Código expirado. Solicite um novo código.');
      case 'LOCKED':
        throw Errors.unprocessable('OTP_LOCKED', 'Número máximo de tentativas atingido. Solicite um novo código.');
      case 'MISMATCH':
        throw Errors.unprocessable('OTP_INVALID', 'Código incorreto.', { remaining_attempts: result.remaining });
      default:
        throw Errors.unprocessable('OTP_NOT_REQUESTED', 'Solicite um código de verificação.');
    }
  }
}
