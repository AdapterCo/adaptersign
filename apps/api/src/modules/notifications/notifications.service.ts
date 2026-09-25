import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { QueueNames, QueueService, type EmailJob } from '../../infra/queue/queues';
import type { EmailTemplateName } from './templates';

export interface CreateNotificationInput {
  template: EmailTemplateName;
  /** E-mail, ou telefone E.164 quando channel = WHATSAPP. */
  recipient: string;
  channel?: 'EMAIL' | 'WHATSAPP';
  /** Chave lógica que impede envio duplicado (ex.: convite por signatário). */
  dedupeKey: string;
  organizationId: string | null;
  envelopeId?: string | null;
  signerId?: string | null;
  /** Somente identificadores — nunca segredos. */
  data: Record<string, string | number | boolean | null>;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  /**
   * Cria a notificação de forma idempotente (ON CONFLICT DO NOTHING — não aborta
   * a transação em caso de duplicidade). Retorna o id, ou null se já existia.
   */
  async create(client: Tx | PrismaService, input: CreateNotificationInput): Promise<string | null> {
    const data = JSON.stringify(input.data);
    const rows = await client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "notifications" ("id", "organization_id", "envelope_id", "signer_id", "channel", "template", "recipient", "data", "dedupe_key", "status", "attempts", "created_at")
      VALUES (gen_random_uuid(), ${input.organizationId}::uuid, ${input.envelopeId ?? null}::uuid, ${input.signerId ?? null}::uuid,
              ${input.channel ?? 'EMAIL'}, ${input.template}, ${input.recipient}, ${data}::jsonb, ${input.dedupeKey}, 'PENDING', 0, now())
      ON CONFLICT ("dedupe_key") DO NOTHING
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  /** Enfileira envio. `secret` (ex.: OTP) viaja apenas cifrado no payload do job. */
  async dispatch(notificationId: string, secret?: string): Promise<void> {
    await this.queues.add<EmailJob & { secret?: string }>(
      QueueNames.EMAIL,
      'send',
      { notificationId, ...(secret ? { secret } : {}) },
      { jobId: `email-${notificationId}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
    );
  }

  async pendingSince(date: Date, limit = 200) {
    return this.prisma.notification.findMany({
      where: { status: 'PENDING', createdAt: { lt: date }, NOT: { template: 'signer_otp' } },
      select: { id: true },
      take: limit,
    });
  }
}

export type NotificationData = Prisma.JsonObject;
