import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { JobsOptions, Queue } from 'bullmq';
import type Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { createRedis } from '../redis/redis.provider';

export const QueueNames = {
  OUTBOX: 'outbox',
  EMAIL: 'email',
  WEBHOOK: 'webhook',
  FINALIZATION: 'finalization',
  MAINTENANCE: 'maintenance',
} as const;
export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

// Jobs carregam apenas IDs; o estado autoritativo fica no PostgreSQL.
export interface OutboxJob {
  outboxEventId: string;
}
export interface EmailJob {
  notificationId: string;
}
export interface WebhookJob {
  deliveryId: string;
}
export interface FinalizationJob {
  envelopeId: string;
  requestId?: string | null;
}
export interface MaintenanceJob {
  task: 'expire_envelopes' | 'send_reminders' | 'sweep_outbox' | 'sweep_webhooks' | 'cleanup';
}

const defaultJobOptions: JobsOptions = {
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  // Falhas permanentes ficam retidas (dead-letter administrável no painel).
  removeOnFail: { age: 30 * 24 * 3600 },
};

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  readonly queues: Record<QueueName, Queue>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.connection = createRedis(config.REDIS_URL);
    this.queues = Object.fromEntries(
      Object.values(QueueNames).map((name) => [name, new Queue(name, { connection: this.connection, defaultJobOptions })]),
    ) as Record<QueueName, Queue>;
  }

  async add<T extends object>(queue: QueueName, name: string, data: T, opts: JobsOptions = {}): Promise<void> {
    await this.queues[queue].add(name, data, opts);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
    await this.connection.quit();
  }
}
