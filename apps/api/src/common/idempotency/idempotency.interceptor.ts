import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { from, lastValueFrom, Observable, of } from 'rxjs';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { canonicalJson, sha256Hex } from '../crypto/crypto.util';
import { AppError, Errors } from '../errors/app-error';
import type { AuthedRequest } from '../auth/decorators';

export const IDEMPOTENT = 'idempotent';
/** Aceita cabeçalho Idempotency-Key: repetições retornam a mesma resposta sem reexecutar. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

const TTL_MS = 24 * 3600 * 1000;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const rawKey = req.headers['idempotency-key'];
    if (!enabled || typeof rawKey !== 'string' || !req.auth) return next.handle();
    return from(this.handle(context, next, rawKey, req));
  }

  private async handle(context: ExecutionContext, next: CallHandler, key: string, req: AuthedRequest): Promise<unknown> {
    if (key.length < 8 || key.length > 128) throw Errors.validation('Idempotency-Key deve ter entre 8 e 128 caracteres.');
    const auth = req.auth!;
    const res = context.switchToHttp().getResponse<Response>();
    const scope = `${req.method} ${req.baseUrl ?? ''}${req.path}`;
    const requestHash = sha256Hex(canonicalJson(req.body ?? {}));

    let recordId: string;
    try {
      const created = await this.prisma.idempotencyRecord.create({
        data: { organizationId: auth.organizationId, scope, key, requestHash, expiresAt: new Date(Date.now() + TTL_MS) },
        select: { id: true },
      });
      recordId = created.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: { organizationId_scope_key: { organizationId: auth.organizationId, scope, key } },
      });
      if (!existing) throw Errors.conflict('IDEMPOTENCY_CONFLICT', 'Conflito de idempotência. Tente novamente.');
      if (existing.requestHash !== requestHash) {
        throw Errors.unprocessable('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key já utilizada com outro conteúdo.');
      }
      if (existing.status === 'IN_PROGRESS') {
        throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'Requisição com esta Idempotency-Key ainda em processamento.');
      }
      res.status(existing.responseStatus ?? 200);
      res.setHeader('Idempotent-Replayed', 'true');
      return existing.responseBody;
    }

    try {
      const body = await lastValueFrom(next.handle().pipe(), { defaultValue: undefined });
      await this.prisma.idempotencyRecord.update({
        where: { id: recordId },
        data: {
          status: 'COMPLETED',
          responseStatus: res.statusCode,
          responseBody: body === undefined ? Prisma.JsonNull : (JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue),
        },
      });
      return body;
    } catch (err) {
      // Falha: libera a chave para nova tentativa legítima.
      await this.prisma.idempotencyRecord.delete({ where: { id: recordId } }).catch(() => undefined);
      if (err instanceof AppError) throw err;
      throw err;
    }
  }
}

// Utilitário para testes/documentação.
export const replay = (body: unknown) => of(body);
