import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';

/** Contexto mínimo para comandos operacionais (sem HTTP, Redis ou filas). */
@Module({
  imports: [ConfigModule],
  providers: [PrismaService, AuditService],
  exports: [PrismaService, AuditService],
})
export class CliModule {}
