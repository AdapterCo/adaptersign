import { Inject, Injectable, Logger } from '@nestjs/common';
import { WebhookDeliveryStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { QueueNames, QueueService, type WebhookJob } from '../../infra/queue/queues';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { BRANDING } from '../../config/config.module';
import type { Branding } from '../../config/branding';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { assertSafeWebhookUrl } from './url-safety';
import { signWebhook, WEBHOOK_HEADERS } from './webhook-signature';

/** Tentativas: imediato, 1 min, 5 min, 30 min, 2 h (seção 44). Após a última: DEAD. */
export const RETRY_SCHEDULE_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger('WebhookDelivery');

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly queues: QueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BRANDING) private readonly brand: Branding,
  ) {}

  async deliver(deliveryId: string): Promise<void> {
    const d = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } });
    if (!d || d.status === WebhookDeliveryStatus.SUCCEEDED || d.status === WebhookDeliveryStatus.DEAD) return;
    if (d.endpoint.deletedAt || !d.endpoint.active) {
      await this.prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: WebhookDeliveryStatus.DEAD, lastError: 'endpoint inativo ou removido' } });
      return;
    }

    const attempt = d.attempts + 1;
    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const started = Date.now();
    let statusCode: number | null = null;
    let error: string | null = null;

    try {
      const url = await assertSafeWebhookUrl(d.endpoint.url, this.config.WEBHOOK_ALLOW_PRIVATE_TARGETS);
      const secret = this.encryption.decrypt(d.endpoint.secretEncrypted);
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.WEBHOOK_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `${this.brand.name.replace(/[^A-Za-z0-9]/g, '')}-Webhooks/1.0`,
          [WEBHOOK_HEADERS.signature]: signWebhook(secret, timestamp, d.eventId, body),
          [WEBHOOK_HEADERS.timestamp]: String(timestamp),
          [WEBHOOK_HEADERS.eventId]: d.eventId,
          [WEBHOOK_HEADERS.eventType]: d.eventType,
          [WEBHOOK_HEADERS.attempt]: String(attempt),
        },
        body,
      });
      statusCode = res.status;
      // Corpo da resposta NÃO é armazenado (pode conter segredos do cliente).
      await res.body?.cancel().catch(() => undefined);
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);
    }
    const responseTimeMs = Date.now() - started;
    const success = error === null;
    const nextDelay = RETRY_SCHEDULE_MS[attempt];
    const dead = !success && nextDelay === undefined;

    await this.prisma.tx(async (tx) => {
      await tx.webhookDeliveryAttempt.create({ data: { deliveryId: d.id, attempt, statusCode, responseTimeMs, error } });
      await tx.webhookDelivery.update({
        where: { id: d.id },
        data: {
          attempts: attempt,
          lastStatusCode: statusCode,
          lastError: error,
          status: success ? WebhookDeliveryStatus.SUCCEEDED : dead ? WebhookDeliveryStatus.DEAD : WebhookDeliveryStatus.RETRYING,
          deliveredAt: success ? new Date() : null,
          nextAttemptAt: success || dead ? null : new Date(Date.now() + nextDelay),
        },
      });
    });

    this.logger.log({ event: 'webhook_attempt', delivery_id: d.id, event_id: d.eventId, attempt, status_code: statusCode, success, dead });
    if (!success && !dead) {
      await this.queues.add<WebhookJob>(QueueNames.WEBHOOK, 'deliver', { deliveryId: d.id }, { jobId: `webhook-${d.id}-${attempt}-${Date.now()}`, delay: nextDelay });
    }
  }
}
