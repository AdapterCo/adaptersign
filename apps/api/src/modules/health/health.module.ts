import { Controller, Get, HttpStatus, Inject, Module, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { REDIS } from '../../infra/redis/redis.provider';
import { StorageService } from '../../infra/storage/storage.service';
import { Public } from '../../common/auth/decorators';

async function check(fn: () => Promise<unknown>, timeoutMs = 3000): Promise<'up' | 'down'> {
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);
    return 'up';
  } catch {
    return 'down';
  }
}

/** /health = processo vivo; /ready = dependências essenciais acessíveis. Sem detalhes sensíveis. */
@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly storage: StorageService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, redis, storage] = await Promise.all([
      check(() => this.prisma.$queryRaw`SELECT 1`),
      check(() => this.redis.ping()),
      check(() => this.storage.ping()),
    ]);
    const ok = database === 'up' && redis === 'up' && storage === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ready' : 'not_ready', checks: { database, redis, storage } };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
