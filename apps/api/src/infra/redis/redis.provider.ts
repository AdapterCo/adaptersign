import type { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export const REDIS = Symbol('REDIS');

export function createRedis(url: string, forWorker = false): Redis {
  // BullMQ exige maxRetriesPerRequest=null em conexões de Worker.
  return new Redis(url, {
    maxRetriesPerRequest: forWorker ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => createRedis(config.REDIS_URL),
};
