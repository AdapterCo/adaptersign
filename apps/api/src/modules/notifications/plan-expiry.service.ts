import { Injectable } from '@nestjs/common';
import { MemberRole } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const DAY = 86_400_000;
/** Aviso antecipado: 3 dias antes do fim do período pago. */
export const EXPIRY_NOTICE_DAYS = 3;

/**
 * Avisos de vencimento do plano pago (pré-pago, sem renovação automática): um e-mail
 * EXPIRY_NOTICE_DAYS antes e outro ao vencer, para os administradores da organização.
 * Idempotente: a chave inclui o fim do período, então cada aviso sai uma única vez por período
 * (renovar gera um novo período e, portanto, novos avisos no futuro).
 */
@Injectable()
export class PlanExpiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async queueNotices(now = new Date()): Promise<number> {
    const subs = await this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        // Vence nos próximos dias ou venceu há pouco (janela para não perder avisos se o worker parar).
        currentPeriodEnd: { gt: new Date(now.getTime() - 2 * DAY), lte: new Date(now.getTime() + EXPIRY_NOTICE_DAYS * DAY) },
      },
      select: { id: true, organizationId: true, currentPeriodEnd: true },
    });
    let queued = 0;
    for (const sub of subs) {
      const end = sub.currentPeriodEnd!;
      const kind = end > now ? 'plan_expiring' : 'plan_expired';
      const admins = await this.prisma.organizationMember.findMany({
        where: {
          organizationId: sub.organizationId,
          role: { in: [MemberRole.OWNER, MemberRole.ADMIN] },
          user: { deletedAt: null },
          organization: { deletedAt: null },
        },
        select: { user: { select: { id: true, email: true } } },
      });
      for (const { user } of admins) {
        const id = await this.notifications.create(this.prisma, {
          template: kind,
          recipient: user.email,
          dedupeKey: `${kind}:${sub.id}:${end.toISOString()}:${user.id}`,
          organizationId: sub.organizationId,
          data: { userId: user.id, organizationId: sub.organizationId, periodEnd: end.toISOString() },
        });
        if (id) {
          await this.notifications.dispatch(id);
          queued++;
        }
      }
    }
    return queued;
  }
}
