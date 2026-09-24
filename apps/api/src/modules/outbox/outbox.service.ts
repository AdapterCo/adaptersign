import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../infra/prisma/prisma.service';
import { QueueNames, QueueService, type OutboxJob } from '../../infra/queue/queues';
import type { DomainEventType } from './domain-events';

export interface EmittedEvent {
  id: string;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger('Outbox');

  constructor(private readonly queues: QueueService) {}

  /** Grava o evento na MESMA transação da mudança de estado (outbox transacional). */
  async emit(
    tx: Tx,
    input: { type: DomainEventType; organizationId: string | null; payload: Record<string, unknown>; requestId?: string | null },
  ): Promise<EmittedEvent> {
    const row = await tx.outboxEvent.create({
      data: {
        type: input.type,
        organizationId: input.organizationId,
        payload: input.payload as Prisma.InputJsonObject,
        requestId: input.requestId ?? null,
      },
      select: { id: true },
    });
    return row;
  }

  /**
   * Após o COMMIT: enfileira processamento imediato. Falhas aqui não perdem o evento —
   * o sweeper periódico reprocessa eventos pendentes.
   */
  async dispatch(events: EmittedEvent | EmittedEvent[]): Promise<void> {
    const list = Array.isArray(events) ? events : [events];
    for (const ev of list) {
      try {
        await this.queues.add<OutboxJob>(QueueNames.OUTBOX, 'process', { outboxEventId: ev.id }, { jobId: `outbox-${ev.id}` });
      } catch (err) {
        this.logger.warn({ event: 'outbox_dispatch_failed', outbox_event_id: ev.id, error: (err as Error).message });
      }
    }
  }
}
