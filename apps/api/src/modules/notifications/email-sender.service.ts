import { Inject, Injectable, Logger } from '@nestjs/common';
import { ActorType, SignerStatus, UserTokenPurpose } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../../infra/email/email.provider';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { BRANDING } from '../../config/config.module';
import type { Branding } from '../../config/branding';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { maskEmail } from '../../common/util/mask';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { issueUserToken } from '../auth/user-tokens';
import { issueSignerAccessToken } from '../signing/access-tokens';
import { SIGNABLE_ENVELOPE_STATUSES, TERMINAL_SIGNER_STATUSES, signerSourcesFor } from '../envelopes/envelope-state';
import { EmailTemplates, type RenderedEmail } from './templates';

type Data = Record<string, unknown>;

interface Prepared {
  email: RenderedEmail | null;
  skipReason?: string;
  onSent?: () => Promise<void>;
  onFailed?: () => Promise<void>;
}

/** Worker: renderiza e envia notificações. Tokens de link são gerados no momento do envio. */
@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger('EmailSender');

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BRANDING) private readonly brand: Branding,
  ) {}

  async send(notificationId: string, encryptedSecret: string | undefined, isFinalAttempt: boolean): Promise<void> {
    const n = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!n || n.status === 'SENT') return;
    const data = (n.data ?? {}) as Data;

    const prepared = await this.prepare(n.template, n.recipient, data, encryptedSecret, n.id);
    if (!prepared.email) {
      await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'FAILED', lastError: `skipped: ${prepared.skipReason ?? 'n/a'}` } });
      return;
    }
    try {
      const result = await this.provider.send({
        to: n.recipient,
        ...prepared.email,
        headers: { 'X-Adapter-Notification-ID': n.id },
      });
      await this.prisma.notification.update({
        where: { id: n.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, providerMessageId: result.messageId, lastError: null },
      });
      if (prepared.onSent) await prepared.onSent();
      this.logger.log({ event: 'email_sent', notification_id: n.id, template: n.template, to: maskEmail(n.recipient) });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.prisma.notification.update({
        where: { id: n.id },
        data: { attempts: { increment: 1 }, lastError: message, ...(isFinalAttempt ? { status: 'FAILED' } : {}) },
      });
      if (prepared.onFailed) await prepared.onFailed();
      this.logger.warn({ event: 'email_failed', notification_id: n.id, template: n.template, error: message });
      throw err;
    }
  }

  private link(path: string): string {
    return `${this.brand.appUrl}${path}`;
  }

  private async prepare(template: string, recipient: string, data: Data, secret: string | undefined, notificationId: string): Promise<Prepared> {
    switch (template) {
      case 'signer_invite':
      case 'signer_reminder':
        return this.prepareInvite(String(data.signerId), template === 'signer_reminder', notificationId);
      case 'signer_otp':
        return this.prepareOtp(String(data.signerId), String(data.challengeId), secret);
      case 'envelope_completed_signer':
        return this.prepareCompletedSigner(String(data.signerId));
      case 'envelope_completed_owner':
      case 'envelope_cancelled_owner':
      case 'envelope_expired_owner':
      case 'signer_declined_owner':
        return this.prepareOwner(template, String(data.envelopeId), String(data.userId), data.signerId ? String(data.signerId) : null);
      case 'envelope_cancelled_signer':
      case 'envelope_expired_signer':
        return this.prepareSignerStatus(template, String(data.signerId));
      case 'user_verify_email':
      case 'user_password_reset':
      case 'user_invitation':
        return this.prepareUser(template, String(data.userId), data.organizationId ? String(data.organizationId) : null);
      default:
        return { email: null, skipReason: `template desconhecido: ${template}` };
    }
  }

  private async prepareInvite(signerId: string, reminder: boolean, notificationId: string): Promise<Prepared> {
    const signer = await this.prisma.signer.findUnique({ where: { id: signerId }, include: { envelope: { include: { organization: { select: { name: true } } } } } });
    if (!signer) return { email: null, skipReason: 'signatário inexistente' };
    const env = signer.envelope;
    if (!SIGNABLE_ENVELOPE_STATUSES.includes(env.status) || env.finalizationRequestedAt || TERMINAL_SIGNER_STATUSES.includes(signer.status)) {
      return { email: null, skipReason: 'envelope/signatário não aguarda assinatura' };
    }
    const issued = await this.prisma.tx((tx) => issueSignerAccessToken(tx, this.encryption, signer.id, env.expiresAt, this.config.SIGNER_LINK_TTL_DAYS));
    const tokenHash = this.encryption.hashToken(issued.token, 'signer_access');
    const email = EmailTemplates.signer_invite(this.brand, {
      signerName: signer.name,
      senderOrg: env.organization.name,
      envelopeTitle: env.title,
      message: env.message,
      link: this.link(`/sign/${issued.token}`),
      expiresAt: env.expiresAt,
      reminder,
    });
    return {
      email,
      onFailed: async () => {
        await this.prisma.signerAccessToken.updateMany({ where: { tokenHash }, data: { revokedAt: new Date() } });
      },
      onSent: async () => {
        await this.prisma.tx(async (tx) => {
          const now = new Date();
          if (reminder) {
            await tx.signer.update({ where: { id: signer.id }, data: { reminderCount: { increment: 1 }, lastRemindedAt: now } });
          } else {
            await tx.signer.updateMany({
              where: { id: signer.id, status: { in: signerSourcesFor(SignerStatus.INVITED) } },
              data: { status: SignerStatus.INVITED },
            });
            await tx.signer.updateMany({ where: { id: signer.id, invitedAt: null }, data: { invitedAt: now } });
          }
          await this.audit.record(tx, {
            eventType: reminder ? AuditEventType.REMINDER_SENT : AuditEventType.INVITATION_SENT,
            actor: { type: ActorType.SYSTEM },
            organizationId: env.organizationId,
            envelopeId: env.id,
            signerId: signer.id,
            occurredAt: now,
            metadata: { channel: 'EMAIL', to: maskEmail(signer.email), notificationId, linkExpiresAt: issued.expiresAt },
          });
        });
      },
    };
  }

  private async prepareOtp(signerId: string, challengeId: string, secret: string | undefined): Promise<Prepared> {
    if (!secret) return { email: null, skipReason: 'código indisponível (job sem payload cifrado)' };
    const ch = await this.prisma.authenticationChallenge.findUnique({ where: { id: challengeId }, include: { signer: { include: { envelope: true } } } });
    if (!ch || ch.signerId !== signerId || ch.consumedAt || ch.invalidatedAt || ch.expiresAt <= new Date()) {
      return { email: null, skipReason: 'desafio não está mais ativo' };
    }
    const code = this.encryption.decrypt(secret);
    return {
      email: EmailTemplates.signer_otp(this.brand, {
        signerName: ch.signer.name,
        code,
        minutes: Math.round(this.config.OTP_TTL_SECONDS / 60),
        envelopeTitle: ch.signer.envelope.title,
      }),
    };
  }

  private async prepareCompletedSigner(signerId: string): Promise<Prepared> {
    const signer = await this.prisma.signer.findUnique({ where: { id: signerId }, include: { envelope: true } });
    if (!signer || signer.envelope.status !== 'COMPLETED') return { email: null, skipReason: 'envelope não concluído' };
    const issued = await this.prisma.tx((tx) => issueSignerAccessToken(tx, this.encryption, signer.id, null, this.config.SIGNER_LINK_TTL_DAYS));
    return {
      email: EmailTemplates.envelope_completed(this.brand, {
        recipientName: signer.name,
        envelopeTitle: signer.envelope.title,
        validationCode: signer.envelope.publicValidationCode,
        link: this.link(`/sign/${issued.token}`),
      }),
    };
  }

  private async prepareSignerStatus(template: 'envelope_cancelled_signer' | 'envelope_expired_signer', signerId: string): Promise<Prepared> {
    const signer = await this.prisma.signer.findUnique({ where: { id: signerId }, include: { envelope: true } });
    if (!signer) return { email: null, skipReason: 'signatário inexistente' };
    const ctx = {
      recipientName: signer.name,
      envelopeTitle: signer.envelope.title,
      validationCode: signer.envelope.publicValidationCode,
      link: null,
      reason: signer.envelope.cancelReason,
    };
    return { email: template === 'envelope_cancelled_signer' ? EmailTemplates.envelope_cancelled(this.brand, ctx) : EmailTemplates.envelope_expired(this.brand, ctx) };
  }

  private async prepareOwner(template: string, envelopeId: string, userId: string, signerId: string | null): Promise<Prepared> {
    const [env, user, signer] = await Promise.all([
      this.prisma.envelope.findUnique({ where: { id: envelopeId } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, deletedAt: true } }),
      signerId ? this.prisma.signer.findUnique({ where: { id: signerId }, select: { name: true, declineReason: true } }) : Promise.resolve(null),
    ]);
    if (!env || !user || user.deletedAt) return { email: null, skipReason: 'destinatário indisponível' };
    const ctx = {
      recipientName: user.name,
      envelopeTitle: env.title,
      validationCode: env.publicValidationCode,
      link: this.link(`/envelopes/${env.id}`),
      reason: signer?.declineReason ?? env.cancelReason,
      signerName: signer?.name,
    };
    switch (template) {
      case 'envelope_completed_owner':
        return { email: EmailTemplates.envelope_completed(this.brand, ctx) };
      case 'envelope_cancelled_owner':
        return { email: EmailTemplates.envelope_cancelled(this.brand, ctx) };
      case 'envelope_expired_owner':
        return { email: EmailTemplates.envelope_expired(this.brand, ctx) };
      default:
        return { email: EmailTemplates.signer_declined(this.brand, ctx) };
    }
  }

  private async prepareUser(template: 'user_verify_email' | 'user_password_reset' | 'user_invitation', userId: string, organizationId: string | null): Promise<Prepared> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, deletedAt: true, emailVerifiedAt: true } });
    if (!user || user.deletedAt) return { email: null, skipReason: 'usuário indisponível' };
    if (template === 'user_verify_email') {
      if (user.emailVerifiedAt) return { email: null, skipReason: 'e-mail já verificado' };
      const token = await issueUserToken(this.prisma, this.encryption, userId, UserTokenPurpose.EMAIL_VERIFICATION);
      return { email: EmailTemplates.user_verify_email(this.brand, { name: user.name, link: this.link(`/verify-email?token=${token}`) }) };
    }
    const token = await issueUserToken(this.prisma, this.encryption, userId, UserTokenPurpose.PASSWORD_RESET);
    if (template === 'user_invitation') {
      const org = organizationId ? await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }) : null;
      return {
        email: EmailTemplates.user_invitation(this.brand, { name: user.name, organizationName: org?.name, link: this.link(`/reset-password?token=${token}&invite=1`) }),
      };
    }
    return { email: EmailTemplates.user_password_reset(this.brand, { name: user.name, link: this.link(`/reset-password?token=${token}`) }) };
  }
}
