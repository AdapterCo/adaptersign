import 'reflect-metadata';
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { ActorType } from '../generated/prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { AuditEventType } from '../modules/audit/audit-events';
import { CliModule } from './cli.module';

// Uso: node dist/cli/plans-sync.js <arquivo.json>
// Planos são CONFIGURAÇÃO versionada fora do código (ex.: config/plans.json no servidor).
const planSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,30}$/),
  name: z.string().min(2),
  monthlyEnvelopes: z.number().int().min(0).nullable(),
  monthlyDocuments: z.number().int().min(0).nullable(),
  storageLimitBytes: z.string().regex(/^\d+$/).nullable(),
  usersLimit: z.number().int().min(1).nullable(),
  apiAccess: z.boolean(),
  webhooks: z.boolean(),
  branding: z.boolean(),
  retentionDays: z.number().int().min(1).nullable(),
  priceCents: z.number().int().min(0).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  active: z.boolean().optional(),
});
const fileSchema = z.object({ plans: z.array(planSchema).min(1) });

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('Uso: plans-sync <arquivo.json>');
  const parsed = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const audit = app.get(AuditService);
  for (const p of parsed.plans) {
    const data = {
      name: p.name,
      monthlyEnvelopes: p.monthlyEnvelopes,
      monthlyDocuments: p.monthlyDocuments,
      storageLimitBytes: p.storageLimitBytes === null ? null : BigInt(p.storageLimitBytes),
      usersLimit: p.usersLimit,
      apiAccess: p.apiAccess,
      webhooks: p.webhooks,
      branding: p.branding,
      retentionDays: p.retentionDays,
      priceCents: p.priceCents ?? null,
      currency: p.currency ?? null,
      active: p.active ?? true,
    };
    await prisma.tx(async (tx) => {
      const plan = await tx.plan.upsert({ where: { code: p.code }, create: { code: p.code, ...data }, update: data });
      await audit.record(tx, {
        eventType: AuditEventType.PLATFORM_PLAN_CHANGED,
        actor: { type: ActorType.SYSTEM, id: 'cli:plans-sync' },
        metadata: { planId: plan.id, ...p },
      });
    });
    process.stdout.write(`plano sincronizado: ${p.code}\n`);
  }
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
