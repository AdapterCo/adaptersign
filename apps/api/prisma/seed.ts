import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { MemberRole, PrismaClient } from '../src/generated/prisma/client';

// Seed SOMENTE para desenvolvimento/testes. Recusa rodar em produção.
// Dados fictícios; a senha do usuário de desenvolvimento vem de SEED_USER_PASSWORD (sem padrão).
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Seed não pode ser executado em produção.');
  const password = process.env.SEED_USER_PASSWORD;
  if (!password || password.length < 10) throw new Error('Defina SEED_USER_PASSWORD (mínimo 10 caracteres) para o seed de desenvolvimento.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

  const file = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'plans.example.json'), 'utf8')) as {
    plans: Array<Record<string, unknown> & { code: string; storageLimitBytes: string | null }>;
  };
  for (const p of file.plans) {
    const data = {
      name: String(p.name),
      monthlyEnvelopes: (p.monthlyEnvelopes as number | null) ?? null,
      monthlyDocuments: (p.monthlyDocuments as number | null) ?? null,
      storageLimitBytes: p.storageLimitBytes ? BigInt(p.storageLimitBytes) : null,
      usersLimit: (p.usersLimit as number | null) ?? null,
      apiAccess: Boolean(p.apiAccess),
      webhooks: Boolean(p.webhooks),
      branding: Boolean(p.branding),
      retentionDays: (p.retentionDays as number | null) ?? null,
    };
    await prisma.plan.upsert({ where: { code: p.code }, create: { code: p.code, ...data }, update: data });
  }

  const email = 'dev@exemplo.test';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const user = await prisma.user.create({
      data: { email, name: 'Usuária de Desenvolvimento', passwordHash: await argon2.hash(password, { type: argon2.argon2id }), emailVerifiedAt: new Date() },
    });
    const org = await prisma.organization.create({ data: { name: 'Empresa Fictícia Ltda', slug: 'empresa-ficticia' } });
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: MemberRole.OWNER } });
    const pro = await prisma.plan.findUniqueOrThrow({ where: { code: 'PRO' } });
    await prisma.subscription.create({
      data: { organizationId: org.id, planId: pro.id, status: 'ACTIVE', provider: 'manual', currentPeriodStart: new Date() },
    });
  }
  await prisma.$disconnect();
  process.stdout.write(`seed ok — login: ${email}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
