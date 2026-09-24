import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from './prisma/prisma.service';
import { REDIS, redisProvider } from './redis/redis.provider';
import { StorageService } from './storage/storage.service';
import { QueueService } from './queue/queues';
import { EMAIL_PROVIDER, SmtpEmailProvider } from './email/email.provider';
import { EncryptionService } from '../common/crypto/encryption.service';

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    StorageService,
    QueueService,
    EncryptionService,
    { provide: EMAIL_PROVIDER, useClass: SmtpEmailProvider },
  ],
  exports: [PrismaService, REDIS, StorageService, QueueService, EncryptionService, EMAIL_PROVIDER],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
