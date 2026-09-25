import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from './prisma/prisma.service';
import { REDIS, redisProvider } from './redis/redis.provider';
import { StorageService } from './storage/storage.service';
import { QueueService } from './queue/queues';
import { EMAIL_PROVIDER, SmtpEmailProvider } from './email/email.provider';
import { WHATSAPP_PROVIDER, whatsappProvider } from './whatsapp/whatsapp.provider';
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
    whatsappProvider,
  ],
  exports: [PrismaService, REDIS, StorageService, QueueService, EncryptionService, EMAIL_PROVIDER, WHATSAPP_PROVIDER],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
