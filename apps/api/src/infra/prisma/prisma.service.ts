import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Transação interativa com isolamento READ COMMITTED + locks explícitos
   * (SELECT ... FOR UPDATE) nas operações que exigem serialização.
   */
  tx<T>(fn: (tx: Tx) => Promise<T>, timeoutMs = 15000): Promise<T> {
    return this.$transaction(fn, { maxWait: 5000, timeout: timeoutMs });
  }
}
