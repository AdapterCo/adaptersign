import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { PrismaService } from '../infra/prisma/prisma.service';
import { createRedis } from '../infra/redis/redis.provider';
import {
  QueueNames,
  QueueService,
  type EmailJob,
  type FinalizationJob,
  type MaintenanceJob,
  type OutboxJob,
  type WebhookJob,
} from '../infra/queue/queues';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DomainEvent } from '../modules/outbox/domain-events';
import { NotificationDispatcherService } from '../modules/notifications/notification-dispatcher.service';
import { EmailSenderService } from '../modules/notifications/email-sender.service';
import { WebhooksService } from '../modules/webhooks/webhooks.service';
import { WebhookDeliveryService } from '../modules/webhooks/webhook-delivery.service';
import { FinalizationIntegrityError, FinalizationService } from '../modules/evidence/finalization.service';
import { EnvelopeLifecycleService } from '../modules/envelopes/envelope-lifecycle.service';

/**
 * Processos assíncronos (seção 5/96): jobs idempotentes, observáveis (logs com request_id),
 * retentáveis e com falhas permanentes retidas para administração (dead-letter).
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private readonly workers: Worker[] = [];
  private readonly connections: Redis[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly emailSender: EmailSenderService,
    private readonly webhooks: WebhooksService,
    private readonly webhookDelivery: WebhookDeliveryService,
    private readonly finalization: FinalizationService,
    private readonly lifecycle: EnvelopeLifecycleService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private start<T>(name: string, concurrency: number, handler: (job: Job<T>) => Promise<void>): void {
    const connection = createRedis(this.config.REDIS_URL, true);
    this.connections.push(connection);
    const worker = new Worker<T>(name, handler, { connection, concurrency });
    worker.on('failed', (job, err) => {
      this.logger.warn({ event: 'job_failed', queue: name, job_id: job?.id, attempts: job?.attemptsMade, error: err.message });
    });
    worker.on('error', (err) => this.logger.error({ event: 'worker_error', queue: name, error: err.message }));
    this.workers.push(worker);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.start<OutboxJob>(QueueNames.OUTBOX, 5, (job) => this.processOutbox(job.data.outboxEventId));
    this.start<EmailJob & { secret?: string }>(QueueNames.EMAIL, 5, (job) =>
      this.emailSender.send(job.data.notificationId, job.data.secret, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
    );
    this.start<WebhookJob>(QueueNames.WEBHOOK, 10, (job) => this.webhookDelivery.deliver(job.data.deliveryId));
    this.start<FinalizationJob>(QueueNames.FINALIZATION, 2, async (job) => {
      try {
        const result = await this.finalization.finalize(job.data.envelopeId, job.data.requestId ?? null);
        this.logger.log({ event: 'finalization_job', envelope_id: job.data.envelopeId, result, request_id: job.data.requestId ?? null });
      } catch (err) {
        if (err instanceof FinalizationIntegrityError) {
          // Falha de integridade não é resolvida por retentativa: exige análise humana.
          this.logger.error({ event: 'finalization_integrity_error', envelope_id: job.data.envelopeId, error: err.message });
          throw new UnrecoverableError(err.message);
        }
        throw err;
      }
    });
    this.start<MaintenanceJob>(QueueNames.MAINTENANCE, 1, (job) => this.maintenance(job.data.task));

    const maintenance = this.queues.queues[QueueNames.MAINTENANCE];
    const schedules: Array<[string, number, MaintenanceJob['task']]> = [
      ['expire-envelopes', 60_000, 'expire_envelopes'],
      ['send-reminders', 15 * 60_000, 'send_reminders'],
      ['sweep-outbox', 60_000, 'sweep_outbox'],
      ['sweep-webhooks', 5 * 60_000, 'sweep_webhooks'],
      ['cleanup', 6 * 3600_000, 'cleanup'],
    ];
    for (const [id, every, task] of schedules) {
      await maintenance.upsertJobScheduler(id, { every }, { name: 'maintenance', data: { task } });
    }
    this.logger.log({ event: 'worker_started', queues: Object.values(QueueNames) });
  }

  /** Processa um evento do outbox. Handlers são idempotentes (dedupe keys / unique constraints). */
  private async processOutbox(outboxEventId: string): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: outboxEventId } });
    if (!event || event.processedAt) return;
    try {
      await this.dispatcher.handle(event);
      await this.webhooks.fanout(event);
      if (event.type === DomainEvent.ENVELOPE_FINALIZATION_REQUESTED) {
        const envelopeId = String((event.payload as Record<string, unknown>).envelopeId);
        await this.queues.add<FinalizationJob>(
          QueueNames.FINALIZATION,
          'finalize',
          { envelopeId, requestId: event.requestId },
          { jobId: `finalize-${envelopeId}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
        );
      }
      await this.prisma.outboxEvent.updateMany({ where: { id: event.id, processedAt: null }, data: { processedAt: new Date() } });
      this.logger.log({ event: 'outbox_processed', outbox_event_id: event.id, type: event.type, request_id: event.requestId });
    } catch (err) {
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, lastError: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
  }

  private async maintenance(task: MaintenanceJob['task']): Promise<void> {
    const bucket = Math.floor(Date.now() / 60_000);
    switch (task) {
      case 'expire_envelopes': {
        const n = await this.lifecycle.expireDue();
        if (n) this.logger.log({ event: 'envelopes_expired', count: n });
        // Finalizações pendentes cujo job se perdeu.
        const stuck = await this.prisma.envelope.findMany({
          where: {
            finalizationRequestedAt: { lt: new Date(Date.now() - 2 * 60_000) },
            status: { in: ['ACTIVE', 'PARTIALLY_SIGNED'] },
          },
          select: { id: true },
          take: 50,
        });
        for (const e of stuck) {
          await this.queues.add<FinalizationJob>(QueueNames.FINALIZATION, 'finalize', { envelopeId: e.id }, {
            jobId: `finalize-${e.id}-sweep-${Math.floor(bucket / 15)}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
          });
        }
        return;
      }
      case 'send_reminders': {
        const n = await this.lifecycle.queueDueReminders();
        if (n) this.logger.log({ event: 'reminders_queued', envelopes: n });
        return;
      }
      case 'sweep_outbox': {
        const pending = await this.prisma.outboxEvent.findMany({
          where: { processedAt: null, createdAt: { lt: new Date(Date.now() - 30_000) }, attempts: { lt: 10 } },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: 200,
        });
        for (const p of pending) {
          await this.queues.add<OutboxJob>(QueueNames.OUTBOX, 'process', { outboxEventId: p.id }, {
            jobId: `outbox-${p.id}-sweep-${bucket}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 10_000 },
          });
        }
        return;
      }
      case 'sweep_webhooks': {
        const lost = await this.prisma.webhookDelivery.findMany({
          where: { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lt: new Date(Date.now() - 5 * 60_000) } },
          select: { id: true },
          take: 200,
        });
        for (const d of lost) {
          await this.queues.add<WebhookJob>(QueueNames.WEBHOOK, 'deliver', { deliveryId: d.id }, { jobId: `webhook-${d.id}-sweep-${bucket}` });
        }
        return;
      }
      case 'cleanup': {
        const now = new Date();
        const idem = await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } });
        // Tokens de refresh expirados há mais de 30 dias (não são evidência de assinatura).
        const rt = await this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 30 * 24 * 3600_000) } } });
        this.logger.log({ event: 'cleanup', idempotency_records: idem.count, refresh_tokens: rt.count });
        return;
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}
