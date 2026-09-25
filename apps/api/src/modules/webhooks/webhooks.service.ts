import { Inject, Injectable } from '@nestjs/common';
import { Prisma, WebhookDeliveryStatus, type OutboxEvent } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { QueueNames, QueueService, type WebhookJob } from '../../infra/queue/queues';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { randomToken } from '../../common/crypto/crypto.util';
import { Errors } from '../../common/errors/app-error';
import { paginated, resolvePagination, type PaginationQueryDto } from '../../common/util/pagination';
import type { ClientInfo } from '../../common/http/client-info';
import { actorOf, type AuthContext } from '../../common/auth/auth-context';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { LimitsService } from '../billing/limits.service';
import { PUBLIC_WEBHOOK_EVENTS } from '../outbox/domain-events';
import { assertSafeWebhookUrl } from './url-safety';

export interface WebhookInput {
  url: string;
  events: string[];
  description?: string;
  active?: boolean;
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly limits: LimitsService,
    private readonly queues: QueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private validateEvents(events: string[]): string[] {
    const unique = [...new Set(events)];
    const invalid = unique.filter((e) => !PUBLIC_WEBHOOK_EVENTS.includes(e));
    if (unique.length === 0 || invalid.length > 0) {
      throw Errors.validation('Eventos de webhook inválidos.', { invalid, allowed: [...PUBLIC_WEBHOOK_EVENTS] });
    }
    return unique;
  }

  private serialize(e: { id: string; url: string; description: string | null; events: string[]; active: boolean; secretPrefix: string; createdAt: Date; updatedAt: Date }) {
    return { id: e.id, url: e.url, description: e.description, events: e.events, active: e.active, secretPrefix: e.secretPrefix, createdAt: e.createdAt, updatedAt: e.updatedAt };
  }

  async list(auth: AuthContext) {
    const rows = await this.prisma.webhookEndpoint.findMany({ where: { organizationId: auth.organizationId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.serialize(r));
  }

  /** Cria endpoint e devolve o segredo HMAC em claro UMA única vez. */
  async create(auth: AuthContext, input: WebhookInput, client: ClientInfo) {
    const events = this.validateEvents(input.events);
    await assertSafeWebhookUrl(input.url, this.config.WEBHOOK_ALLOW_PRIVATE_TARGETS);
    const secret = `whsec_${randomToken(32)}`;
    const endpoint = await this.prisma.tx(async (tx) => {
      await this.limits.assertWebhooksAllowed(tx, auth.organizationId);
      const count = await tx.webhookEndpoint.count({ where: { organizationId: auth.organizationId, deletedAt: null } });
      if (count >= 20) throw Errors.unprocessable('TOO_MANY_WEBHOOKS', 'Limite de 20 webhooks por organização.');
      const e = await tx.webhookEndpoint.create({
        data: {
          organizationId: auth.organizationId,
          url: input.url,
          description: input.description ?? null,
          events,
          active: input.active ?? true,
          secretEncrypted: this.encryption.encrypt(secret),
          secretPrefix: secret.slice(0, 12),
          createdById: auth.kind === 'user' ? auth.userId : null,
        },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.WEBHOOK_CREATED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { webhookId: e.id, url: e.url, events },
      });
      return e;
    });
    return { ...this.serialize(endpoint), secret };
  }

  async update(auth: AuthContext, id: string, input: Partial<WebhookInput>, client: ClientInfo) {
    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (input.url !== undefined) {
      await assertSafeWebhookUrl(input.url, this.config.WEBHOOK_ALLOW_PRIVATE_TARGETS);
      data.url = input.url;
    }
    if (input.events !== undefined) data.events = this.validateEvents(input.events);
    if (input.description !== undefined) data.description = input.description;
    if (input.active !== undefined) data.active = input.active;
    const updated = await this.prisma.tx(async (tx) => {
      const e = await tx.webhookEndpoint.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
      if (!e) throw Errors.notFound('WEBHOOK_NOT_FOUND', 'Webhook não encontrado.');
      const u = await tx.webhookEndpoint.update({ where: { id: e.id }, data });
      await this.audit.record(tx, {
        eventType: AuditEventType.WEBHOOK_UPDATED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { webhookId: id, fields: Object.keys(data) },
      });
      return u;
    });
    return this.serialize(updated);
  }

  async rotateSecret(auth: AuthContext, id: string, client: ClientInfo) {
    const secret = `whsec_${randomToken(32)}`;
    const updated = await this.prisma.tx(async (tx) => {
      const e = await tx.webhookEndpoint.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
      if (!e) throw Errors.notFound('WEBHOOK_NOT_FOUND', 'Webhook não encontrado.');
      const u = await tx.webhookEndpoint.update({ where: { id }, data: { secretEncrypted: this.encryption.encrypt(secret), secretPrefix: secret.slice(0, 12) } });
      await this.audit.record(tx, { eventType: AuditEventType.WEBHOOK_SECRET_ROTATED, actor: actorOf(auth), organizationId: auth.organizationId, ...client, metadata: { webhookId: id } });
      return u;
    });
    return { ...this.serialize(updated), secret };
  }

  async remove(auth: AuthContext, id: string, client: ClientInfo) {
    await this.prisma.tx(async (tx) => {
      const e = await tx.webhookEndpoint.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
      if (!e) throw Errors.notFound('WEBHOOK_NOT_FOUND', 'Webhook não encontrado.');
      await tx.webhookEndpoint.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
      await this.audit.record(tx, { eventType: AuditEventType.WEBHOOK_DELETED, actor: actorOf(auth), organizationId: auth.organizationId, ...client, metadata: { webhookId: id } });
    });
  }

  async deliveries(auth: AuthContext, endpointId: string, q: PaginationQueryDto) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const where = { endpointId, organizationId: auth.organizationId };
    const [total, rows] = await Promise.all([
      this.prisma.webhookDelivery.count({ where }),
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          eventId: true,
          eventType: true,
          status: true,
          attempts: true,
          lastStatusCode: true,
          lastError: true,
          nextAttemptAt: true,
          deliveredAt: true,
          createdAt: true,
          attemptsLog: { orderBy: { attempt: 'asc' }, select: { attempt: true, statusCode: true, responseTimeMs: true, error: true, createdAt: true } },
        },
      }),
    ]);
    return paginated(rows, total, page, pageSize);
  }

  async redeliver(organizationId: string | null, deliveryId: string): Promise<void> {
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, ...(organizationId ? { organizationId } : {}) } });
    if (!d) throw Errors.notFound('DELIVERY_NOT_FOUND', 'Entrega não encontrada.');
    if (d.status === WebhookDeliveryStatus.SUCCEEDED) throw Errors.conflict('ALREADY_DELIVERED', 'Entrega já realizada com sucesso.');
    await this.prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: WebhookDeliveryStatus.RETRYING, attempts: 0, nextAttemptAt: new Date() } });
    await this.queues.add<WebhookJob>(QueueNames.WEBHOOK, 'deliver', { deliveryId: d.id }, { jobId: `webhook-${d.id}-manual-${Date.now()}` });
  }

  /** Worker: cria entregas (idempotentes por endpoint+event_id) para um evento de domínio. */
  async fanout(event: OutboxEvent): Promise<number> {
    if (!event.organizationId || !PUBLIC_WEBHOOK_EVENTS.includes(event.type)) return 0;
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { organizationId: event.organizationId, deletedAt: null, active: true, events: { has: event.type } },
      select: { id: true },
    });
    if (endpoints.length === 0) return 0;
    const payload = await this.buildPayload(event);
    await this.prisma.webhookDelivery.createMany({
      data: endpoints.map((e) => ({
        organizationId: event.organizationId!,
        endpointId: e.id,
        eventId: event.id,
        eventType: event.type,
        payload: payload as Prisma.InputJsonObject,
        nextAttemptAt: new Date(),
      })),
      skipDuplicates: true,
    });
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: { eventId: event.id, status: WebhookDeliveryStatus.PENDING },
      select: { id: true },
    });
    for (const d of deliveries) {
      await this.queues.add<WebhookJob>(QueueNames.WEBHOOK, 'deliver', { deliveryId: d.id }, { jobId: `webhook-${d.id}-0` });
    }
    return deliveries.length;
  }

  /** Payload mínimo (LGPD): somente dados que a própria organização já possui. */
  private async buildPayload(event: OutboxEvent): Promise<Record<string, unknown>> {
    const p = event.payload as Record<string, unknown>;
    const envelope = p.envelopeId
      ? await this.prisma.envelope.findUnique({
          where: { id: String(p.envelopeId) },
          select: {
            id: true,
            title: true,
            status: true,
            publicValidationCode: true,
            completedAt: true,
            expiresAt: true,
            externalRef: true,
            documents: { orderBy: { position: 'asc' }, select: { id: true, finalStorageKey: true, documentVersion: { select: { filename: true } } } },
          },
        })
      : null;
    const signer = p.signerId
      ? await this.prisma.signer.findUnique({
          where: { id: String(p.signerId) },
          select: { id: true, name: true, email: true, status: true, role: true, roleKey: true },
        })
      : null;
    return {
      id: event.id,
      type: event.type,
      created_at: event.createdAt.toISOString(),
      organization_id: event.organizationId,
      data: {
        envelope: envelope
          ? {
              id: envelope.id,
              title: envelope.title,
              status: envelope.status,
              validation_code: envelope.status === 'DRAFT' ? null : envelope.publicValidationCode,
              completed_at: envelope.completedAt?.toISOString() ?? null,
              expires_at: envelope.expiresAt?.toISOString() ?? null,
              external_ref: envelope.externalRef,
              // Para baixar o PDF final: GET /envelopes/{id}/documents/{document.id}/final (após COMPLETED).
              documents: envelope.documents.map((d) => ({
                id: d.id,
                filename: d.documentVersion.filename,
                final_available: !!d.finalStorageKey,
              })),
            }
          : null,
        signer: signer
          ? { id: signer.id, name: signer.name, email: signer.email, status: signer.status, role: signer.role, role_key: signer.roleKey }
          : null,
        document_id: p.documentId ?? null,
      },
    };
  }
}
