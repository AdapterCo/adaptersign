import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.provider';
import { Errors } from '../errors/app-error';
import type { AuthedRequest } from '../auth/decorators';

export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

// Políticas distintas por tipo de operação (seção 46).
export const RateLimitPolicies = {
  login: { limit: 10, windowSeconds: 15 * 60 },
  register: { limit: 5, windowSeconds: 60 * 60 },
  password_reset: { limit: 5, windowSeconds: 60 * 60 },
  refresh: { limit: 60, windowSeconds: 15 * 60 },
  sign_open: { limit: 30, windowSeconds: 60 },
  otp_request_ip: { limit: 20, windowSeconds: 15 * 60 },
  otp_request_signer: { limit: 5, windowSeconds: 15 * 60 },
  otp_verify: { limit: 15, windowSeconds: 15 * 60 },
  sign: { limit: 20, windowSeconds: 60 },
  verify: { limit: 30, windowSeconds: 60 },
  upload: { limit: 30, windowSeconds: 60 },
  api_key: { limit: 600, windowSeconds: 60 },
  user_default: { limit: 300, windowSeconds: 60 },
  webhook_manage: { limit: 30, windowSeconds: 60 },
} satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RateLimitPolicies;

const SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`;

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Janela fixa atômica (Lua). Lança RATE_LIMITED quando excedido. */
  async consume(policyName: RateLimitPolicyName, identifier: string): Promise<void> {
    const policy: RateLimitPolicy = RateLimitPolicies[policyName];
    const key = `rl:${policyName}:${identifier}`;
    const result = (await this.redis.eval(SCRIPT, 1, key, String(policy.windowSeconds * 1000))) as [number, number];
    const [count, pttl] = result;
    if (count > policy.limit) {
      throw Errors.rateLimited(Math.max(1, Math.ceil(Number(pttl) / 1000)));
    }
  }
}

export const RATE_LIMIT = 'rate_limit:policy';
/** Aplica política por IP (e por credencial, quando autenticado). */
export const RateLimit = (policy: RateLimitPolicyName) => SetMetadata(RATE_LIMIT, policy);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const policy = this.reflector.getAllAndOverride<RateLimitPolicyName | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    const ip = req.ip ?? 'unknown';
    if (policy) await this.limiter.consume(policy, `ip:${ip}`);
    if (req.auth?.kind === 'api_key') await this.limiter.consume('api_key', req.auth.apiKeyId);
    else if (req.auth?.kind === 'user') await this.limiter.consume('user_default', req.auth.userId);
    return true;
  }
}
