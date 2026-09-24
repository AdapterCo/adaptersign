import { Inject, Injectable, Logger } from '@nestjs/common';
import { ActorType, EnvelopeStatus, SignerStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { OutboxService, type EmittedEvent } from '../outbox/outbox.service';
import { DomainEvent } from '../outbox/domain-events';
import { SIGNABLE_ENVELOPE_STATUSES, TERMINAL_SIGNER_STATUSES } from './envelope-state';
import { EnvelopesService } from './envelopes.service';

/** Processos automáticos do ciclo de vida (executados pelo worker). */
@Injectable()
export class EnvelopeLifecycleService {
  private readonly logger = new Logger('EnvelopeLifecycle');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly envelopes: EnvelopesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Expira um envelope vencido. Idempotente e seguro sob concorrência (lock de linha). */
  async expireEnvelope(envelopeId: string, requestId: string | null = null): Promise<boolean> {
    const events = await this.prisma.tx(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "envelopes" WHERE "id" = ${envelopeId}::uuid FOR UPDATE`;
      if (rows.length === 0) return null;
      const env = await tx.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
      const now = new Date();
      if (!SIGNABLE_ENVELOPE_STATUSES.includes(env.status) || !env.expiresAt || env.expiresAt > now || env.finalizationRequestedAt) {
        return null;
      }
      await tx.envelope.update({ where: { id: envelopeId }, data: { status: EnvelopeStatus.EXPIRED, expiredAt: now } });
      await tx.signer.updateMany({
        where: { envelopeId, status: { notIn: [...TERMINAL_SIGNER_STATUSES] } },
        data: { status: SignerStatus.EXPIRED },
      });
      await this.envelopes.revokeSignerAccess(tx, envelopeId, now);
      await this.audit.record(tx, {
        eventType: AuditEventType.ENVELOPE_EXPIRED,
        actor: { type: ActorType.SYSTEM },
        organizationId: env.organizationId,
        envelopeId,
        requestId,
        occurredAt: now,
        metadata: { expiresAt: env.expiresAt },
      });
      return this.outbox.emit(tx, {
        type: DomainEvent.ENVELOPE_EXPIRED,
        organizationId: env.organizationId,
        payload: { envelopeId },
        requestId,
      });
    });
    if (!events) return false;
    await this.outbox.dispatch(events);
    this.logger.log({ event: 'envelope_expired', envelope_id: envelopeId });
    return true;
  }

  async expireDue(limit = 200): Promise<number> {
    const due = await this.prisma.envelope.findMany({
      where: { status: { in: [...SIGNABLE_ENVELOPE_STATUSES] }, expiresAt: { lte: new Date() }, finalizationRequestedAt: null },
      select: { id: true },
      take: limit,
    });
    let count = 0;
    for (const e of due) if (await this.expireEnvelope(e.id)) count++;
    return count;
  }

  /**
   * Lembretes automáticos (24/48/72h, configurável por envelope), com teto de
   * REMINDER_MAX_COUNT por signatário para evitar spam.
   */
  async queueDueReminders(limit = 200): Promise<number> {
    const now = Date.now();
    const envelopes = await this.prisma.envelope.findMany({
      where: { status: { in: [...SIGNABLE_ENVELOPE_STATUSES] }, reminderIntervalHours: { not: null }, finalizationRequestedAt: null },
      select: { id: true, organizationId: true, reminderIntervalHours: true },
      take: limit,
    });
    const emitted: EmittedEvent[] = [];
    for (const env of envelopes) {
      const cutoff = new Date(now - (env.reminderIntervalHours ?? 24) * 3600 * 1000);
      const ev = await this.prisma.tx(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "envelopes" WHERE "id" = ${env.id}::uuid FOR UPDATE`;
        const due = await tx.signer.findMany({
          where: {
            envelopeId: env.id,
            status: { in: [SignerStatus.INVITED, SignerStatus.VIEWED, SignerStatus.AUTHENTICATED] },
            reminderCount: { lt: this.config.REMINDER_MAX_COUNT },
            invitedAt: { lte: cutoff },
            OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lte: cutoff } }],
          },
          select: { id: true },
        });
        if (due.length === 0) return null;
        // Marca antes de emitir: evita lembretes duplicados entre workers.
        await tx.signer.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { lastRemindedAt: new Date() } });
        return this.outbox.emit(tx, {
          type: DomainEvent.SIGNERS_INVITE_REQUESTED,
          organizationId: env.organizationId,
          payload: { envelopeId: env.id, signerIds: due.map((d) => d.id), kind: 'reminder' },
        });
      });
      if (ev) emitted.push(ev);
    }
    await this.outbox.dispatch(emitted);
    return emitted.length;
  }
}
