import { Inject, Injectable } from '@nestjs/common';
import type { Plan } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Errors } from '../../common/errors/app-error';

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Plano vigente: assinatura ativa/trial e dentro do período pago (sem fim = sem vencimento, ex.:
   * atribuída no painel); caso contrário o plano padrão configurado.
   * Planos vêm do banco (configuração), nunca de valores fixos no código.
   */
  async planForOrganization(organizationId: string, client: Tx | PrismaService = this.prisma): Promise<Plan> {
    const sub = await client.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
    const inPeriod = !sub?.currentPeriodEnd || sub.currentPeriodEnd > new Date();
    if (sub && (sub.status === 'ACTIVE' || sub.status === 'TRIALING') && sub.plan.active && inPeriod) return sub.plan;
    const fallback = await client.plan.findUnique({ where: { code: this.config.DEFAULT_PLAN_CODE } });
    if (!fallback) {
      throw Errors.unavailable(
        'PLAN_NOT_CONFIGURED',
        'Nenhum plano configurado para a organização. Contate o suporte.',
      );
    }
    return fallback;
  }

  /** Plano pago (não é o plano padrão/gratuito). */
  isPaidPlan(plan: Plan): boolean {
    return plan.code !== this.config.DEFAULT_PLAN_CODE;
  }
}
