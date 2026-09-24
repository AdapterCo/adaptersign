import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ActorType } from '../generated/prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { AuditEventType } from '../modules/audit/audit-events';
import { normalizeEmail } from '../common/util/text';
import { CliModule } from './cli.module';

// Uso: node dist/cli/grant-platform-admin.js <email> [--revoke]
// Concede acesso ao painel da plataforma a um usuário JÁ CADASTRADO (que definiu a própria senha).
// Nunca cria usuários nem senhas padrão.
async function main(): Promise<void> {
  const email = process.argv[2];
  const revoke = process.argv.includes('--revoke');
  if (!email) throw new Error('Uso: grant-platform-admin <email> [--revoke]');
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const audit = app.get(AuditService);
  await prisma.tx(async (tx) => {
    const user = await tx.user.findUnique({ where: { email: normalizeEmail(email) } });
    if (!user || user.deletedAt) throw new Error('Usuário não encontrado. Cadastre-se pela aplicação primeiro.');
    if (!user.emailVerifiedAt) throw new Error('O e-mail do usuário precisa estar verificado.');
    await tx.user.update({ where: { id: user.id }, data: { isPlatformAdmin: !revoke } });
    await audit.record(tx, {
      eventType: AuditEventType.PLATFORM_ADMIN_GRANTED,
      actor: { type: ActorType.SYSTEM, id: 'cli:grant-platform-admin' },
      metadata: { userId: user.id, granted: !revoke },
    });
  });
  process.stdout.write(`${revoke ? 'Revogado' : 'Concedido'} acesso de administrador da plataforma.\n`);
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
