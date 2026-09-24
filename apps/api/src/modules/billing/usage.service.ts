import { Injectable } from '@nestjs/common';
import { UsageMetric } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';

export function usagePeriod(metric: UsageMetric, at = new Date()): string {
  if (metric === UsageMetric.STORAGE_BYTES) return 'total';
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  /** Incremento atômico (INSERT ... ON CONFLICT DO UPDATE) — seguro sob concorrência. */
  async increment(client: Tx | PrismaService, organizationId: string, metric: UsageMetric, quantity: number | bigint): Promise<void> {
    const period = usagePeriod(metric);
    const qty = BigInt(quantity);
    await client.$executeRaw`
      INSERT INTO "usage_records" ("id", "organization_id", "metric", "period", "quantity", "updated_at")
      VALUES (gen_random_uuid(), ${organizationId}::uuid, ${metric}::"UsageMetric", ${period}, ${qty}, now())
      ON CONFLICT ("organization_id", "metric", "period")
      DO UPDATE SET "quantity" = "usage_records"."quantity" + EXCLUDED."quantity", "updated_at" = now()`;
  }

  async current(organizationId: string, metric: UsageMetric, client: Tx | PrismaService = this.prisma): Promise<bigint> {
    const row = await client.usageRecord.findUnique({
      where: { organizationId_metric_period: { organizationId, metric, period: usagePeriod(metric) } },
      select: { quantity: true },
    });
    return row?.quantity ?? 0n;
  }

  async summary(organizationId: string): Promise<Record<UsageMetric, string>> {
    const metrics = Object.values(UsageMetric);
    const entries = await Promise.all(metrics.map(async (m) => [m, (await this.current(organizationId, m)).toString()] as const));
    return Object.fromEntries(entries) as Record<UsageMetric, string>;
  }
}
