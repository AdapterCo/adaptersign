import { Injectable } from '@nestjs/common';
import { UsageMetric } from '../../generated/prisma/client';
import type { Tx } from '../../infra/prisma/prisma.service';
import { Errors } from '../../common/errors/app-error';
import { PlansService } from './plans.service';
import { UsageService } from './usage.service';

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

  async assertCanCreateEnvelope(tx: Tx, organizationId: string): Promise<void> {
    await this.lockOrganization(tx, organizationId);
    const plan = await this.plans.planForOrganization(organizationId, tx);
    if (plan.monthlyEnvelopes === null) return;
    const used = await this.usage.current(organizationId, UsageMetric.ENVELOPES_CREATED, tx);
    if (used >= BigInt(plan.monthlyEnvelopes)) {
      throw Errors.planLimit('Limite mensal de envelopes do plano atingido.', { limit: plan.monthlyEnvelopes });
    }
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
