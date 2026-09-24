import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EnvelopeStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CurrentAuth, RequirePermission } from '../../common/auth/decorators';
import { Permission, type AuthContext } from '../../common/auth/auth-context';
import { PlansService } from '../billing/plans.service';
import { UsageService } from '../billing/usage.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly usage: UsageService,
  ) {}

  async summary(auth: AuthContext) {
    const orgId = auth.organizationId;
    const [grouped, recent, plan, usage] = await Promise.all([
      this.prisma.envelope.groupBy({ by: ['status'], where: { organizationId: orgId }, _count: { _all: true } }),
      this.prisma.envelope.findMany({
        where: { organizationId: orgId },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: { id: true, title: true, status: true, updatedAt: true, expiresAt: true, signers: { select: { status: true } } },
      }),
      this.plans.planForOrganization(orgId),
      this.usage.summary(orgId),
    ]);
    const counts = Object.fromEntries(Object.values(EnvelopeStatus).map((s) => [s, 0])) as Record<EnvelopeStatus, number>;
    for (const g of grouped) counts[g.status] = g._count._all;
    return {
      counts: {
        ...counts,
        awaitingSignature: counts.ACTIVE + counts.PARTIALLY_SIGNED,
      },
      recent: recent.map((e) => ({
        id: e.id,
        title: e.title,
        status: e.status,
        updatedAt: e.updatedAt,
        expiresAt: e.expiresAt,
        signerCount: e.signers.length,
        signedCount: e.signers.filter((s) => s.status === 'SIGNED').length,
      })),
      plan: {
        code: plan.code,
        name: plan.name,
        monthlyEnvelopes: plan.monthlyEnvelopes,
        monthlyDocuments: plan.monthlyDocuments,
        storageLimitBytes: plan.storageLimitBytes?.toString() ?? null,
      },
      usage,
    };
  }
}

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get()
  summary(@CurrentAuth() auth: AuthContext) {
    return this.dashboard.summary(auth);
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
