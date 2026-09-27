import { Injectable } from '@nestjs/common';
import { UsageMetric } from '../../generated/prisma/client';
import type { Tx } from '../../infra/prisma/prisma.service';
import { Errors } from '../../common/errors/app-error';
import { PlansService } from './plans.service';
import { UsageService } from './usage.service';
import { envelopeQuota, type QuotaSource } from './billing-period';

/**
 * Aplicação de limites do plano. Deve ser chamada dentro da transação da operação,
 * com lock da organização, para evitar ultrapassar limites sob concorrência.
 */
@Injectable()
export class LimitsService {
  constructor(
    private readonly plans: PlansService,
    private readonly usage: UsageService,
  ) {}

  async lockOrganization(tx: Tx, organizationId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
  }

  /**
   * Reserva a cota do próximo envelope (na transação da criação, com a organização travada):
   * plano → bônus do mês (+N%) → documentos extras comprados (debitados aqui; se a transação
   * falhar, o débito é desfeito junto).
   */
  async assertCanCreateEnvelope(tx: Tx, organizationId: string): Promise<QuotaSource> {
    await this.lockOrganization(tx, organizationId);
    const plan = await this.plans.planForOrganization(organizationId, tx);
    if (plan.monthlyEnvelopes === null) return 'unlimited';
    const [used, org] = await Promise.all([
      this.usage.current(organizationId, UsageMetric.ENVELOPES_CREATED, tx),
      tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { extraDocumentCredits: true } }),
    ]);
    const quota = envelopeQuota(plan, Number(used), org.extraDocumentCredits);
    if (quota.next === 'credit') {
      const debited = await tx.organization.updateMany({
        where: { id: organizationId, extraDocumentCredits: { gt: 0 } },
        data: { extraDocumentCredits: { decrement: 1 } },
      });
      if (debited.count === 1) return 'credit';
    } else if (quota.next) {
      return quota.next;
    }
    const paid = this.plans.isPaidPlan(plan);
    throw Errors.planLimit(
      paid
        ? 'Você usou todos os documentos do plano e o bônus deste mês. Compre documentos extras para continuar.'
        : 'Limite mensal de documentos do plano atingido. Contrate um plano para continuar.',
      { limit: quota.limit, bonus: quota.bonus, used: quota.used, extra_credits: quota.credits, can_buy_extra: paid },
    );
  }

  async assertCanUploadDocument(tx: Tx, organizationId: string, sizeBytes: number): Promise<void> {
    await this.lockOrganization(tx, organizationId);
    const plan = await this.plans.planForOrganization(organizationId, tx);
    if (plan.monthlyDocuments !== null) {
      const used = await this.usage.current(organizationId, UsageMetric.DOCUMENTS_UPLOADED, tx);
      if (used >= BigInt(plan.monthlyDocuments)) {
        throw Errors.planLimit('Limite mensal de documentos do plano atingido.', { limit: plan.monthlyDocuments });
      }
    }
    if (plan.storageLimitBytes !== null) {
      const stored = await this.usage.current(organizationId, UsageMetric.STORAGE_BYTES, tx);
      if (stored + BigInt(sizeBytes) > plan.storageLimitBytes) {
        throw Errors.planLimit('Limite de armazenamento do plano atingido.', { limit_bytes: plan.storageLimitBytes.toString() });
      }
    }
  }

  async assertCanAddMember(tx: Tx, organizationId: string): Promise<void> {
    await this.lockOrganization(tx, organizationId);
    const plan = await this.plans.planForOrganization(organizationId, tx);
    if (plan.usersLimit === null) return;
    const count = await tx.organizationMember.count({ where: { organizationId } });
    if (count >= plan.usersLimit) throw Errors.planLimit('Limite de usuários do plano atingido.', { limit: plan.usersLimit });
  }

  async assertWebhooksAllowed(tx: Tx, organizationId: string): Promise<void> {
    const plan = await this.plans.planForOrganization(organizationId, tx);
    if (!plan.webhooks) throw Errors.planLimit('O plano atual não inclui webhooks.');
  }

  async assertApiAccessAllowed(tx: Tx, organizationId: string): Promise<void> {
    const plan = await this.plans.planForOrganization(organizationId, tx);
    if (!plan.apiAccess) throw Errors.planLimit('O plano atual não inclui acesso à API.');
  }
}
