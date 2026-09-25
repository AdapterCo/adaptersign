import { Inject, Injectable } from '@nestjs/common';
import { AuthMethod, SignerStatus, type OutboxEvent } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from '../../infra/whatsapp/whatsapp.provider';
import { DomainEvent, type InviteRequestedPayload } from '../outbox/domain-events';
import { NotificationsService, type CreateNotificationInput } from './notifications.service';

/** Reage a eventos de domínio criando notificações (idempotentes por dedupe_key). */
@Injectable()
export class NotificationDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
  ) {}

  /** Signatário também recebe por WhatsApp (número central) quando há telefone e o canal está ativo. */
  private viaWhatsApp(s: { phone: string | null; authMethod: AuthMethod }): s is { phone: string; authMethod: AuthMethod } {
    return this.whatsapp.enabled && !!s.phone && s.authMethod !== AuthMethod.INTEGRATION;
  }

  async handle(event: OutboxEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const inputs: CreateNotificationInput[] = [];

    switch (event.type) {
      case DomainEvent.SIGNERS_INVITE_REQUESTED: {
        const p = payload as unknown as InviteRequestedPayload;
        const signers = await this.prisma.signer.findMany({
          where: { id: { in: p.signerIds }, envelopeId: p.envelopeId },
          select: { id: true, email: true, phone: true, authMethod: true, organizationId: true },
        });
        for (const s of signers) {
          const template = p.kind === 'reminder' ? 'signer_reminder' : 'signer_invite';
          inputs.push({
            template,
            recipient: s.email,
            dedupeKey: p.kind === 'reminder' ? `reminder:${s.id}:${event.id}` : `invite:${s.id}`,
            organizationId: s.organizationId,
            envelopeId: p.envelopeId,
            signerId: s.id,
            data: { signerId: s.id },
          });
          if (this.viaWhatsApp(s)) {
            inputs.push({
              template,
              channel: 'WHATSAPP',
              recipient: s.phone,
              dedupeKey: p.kind === 'reminder' ? `wa-reminder:${s.id}:${event.id}` : `wa-invite:${s.id}`,
              organizationId: s.organizationId,
              envelopeId: p.envelopeId,
              signerId: s.id,
              data: { signerId: s.id },
            });
          }
        }
        break;
      }
      case DomainEvent.ENVELOPE_COMPLETED:
      case DomainEvent.ENVELOPE_CANCELLED:
      case DomainEvent.ENVELOPE_EXPIRED: {
        const envelopeId = String(payload.envelopeId);
        const env = await this.prisma.envelope.findUnique({
          where: { id: envelopeId },
          include: { signers: { select: { id: true, email: true, phone: true, authMethod: true, status: true, invitedAt: true } } },
        });
        if (!env) break;
        const kind = event.type === DomainEvent.ENVELOPE_COMPLETED ? 'completed' : event.type === DomainEvent.ENVELOPE_CANCELLED ? 'cancelled' : 'expired';
        for (const s of env.signers) {
          const eligible = kind === 'completed' ? s.status === SignerStatus.SIGNED : s.invitedAt !== null;
          if (!eligible) continue;
          inputs.push({
            template: `envelope_${kind}_signer` as CreateNotificationInput['template'],
            recipient: s.email,
            dedupeKey: `${kind}:${envelopeId}:${s.id}`,
            organizationId: env.organizationId,
            envelopeId,
            signerId: s.id,
            data: { signerId: s.id },
          });
          if (kind === 'completed' && this.viaWhatsApp(s)) {
            inputs.push({
              template: 'envelope_completed_signer',
              channel: 'WHATSAPP',
              recipient: s.phone,
              dedupeKey: `wa-completed:${envelopeId}:${s.id}`,
              organizationId: env.organizationId,
              envelopeId,
              signerId: s.id,
              data: { signerId: s.id },
            });
          }
        }
        // O remetente é avisado (exceto do cancelamento que ele próprio fez).
        if (env.createdById && kind !== 'cancelled') {
          const owner = await this.prisma.user.findUnique({ where: { id: env.createdById }, select: { id: true, email: true } });
          if (owner) {
            inputs.push({
              template: `envelope_${kind}_owner` as CreateNotificationInput['template'],
              recipient: owner.email,
              dedupeKey: `${kind}-owner:${envelopeId}`,
              organizationId: env.organizationId,
              envelopeId,
              data: { envelopeId, userId: owner.id },
            });
          }
        }
        break;
      }
      case DomainEvent.SIGNER_DECLINED: {
        const env = await this.prisma.envelope.findUnique({ where: { id: String(payload.envelopeId) } });
        if (!env?.createdById) break;
        const owner = await this.prisma.user.findUnique({ where: { id: env.createdById }, select: { id: true, email: true } });
        if (!owner) break;
        inputs.push({
          template: 'signer_declined_owner',
          recipient: owner.email,
          dedupeKey: `declined-owner:${env.id}:${String(payload.signerId)}`,
          organizationId: env.organizationId,
          envelopeId: env.id,
          data: { envelopeId: env.id, userId: owner.id, signerId: String(payload.signerId) },
        });
        break;
      }
      case DomainEvent.USER_EMAIL_VERIFICATION_REQUESTED:
      case DomainEvent.USER_PASSWORD_RESET_REQUESTED: {
        const user = await this.prisma.user.findUnique({ where: { id: String(payload.userId) }, select: { id: true, email: true } });
        if (!user) break;
        const template =
          event.type === DomainEvent.USER_EMAIL_VERIFICATION_REQUESTED ? 'user_verify_email' : payload.invitation ? 'user_invitation' : 'user_password_reset';
        inputs.push({
          template,
          recipient: user.email,
          dedupeKey: `${template}:${event.id}`,
          organizationId: event.organizationId,
          data: { userId: user.id, organizationId: (payload.organizationId as string | undefined) ?? event.organizationId },
        });
        break;
      }
      default:
        return;
    }

    for (const input of inputs) {
      const id = await this.notifications.create(this.prisma, input);
      if (id) await this.notifications.dispatch(id);
    }
  }
}
