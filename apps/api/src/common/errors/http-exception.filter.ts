import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from './app-error';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string | null;
    details?: Record<string, unknown>;
  };
}

function isPrismaKnownError(e: unknown): e is { code: string; name: string; meta?: unknown } {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'PrismaClientKnownRequestError' &&
    typeof (e as { code?: unknown }).code === 'string'
  );
}

// Padrão único de erro: { error: { code, message, request_id } }. Nunca retorna stack trace.
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = (req?.id as string | undefined) ?? null;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Erro interno. Tente novamente mais tarde.';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (status === HttpStatus.BAD_REQUEST) {
        code = 'VALIDATION_ERROR';
        message = 'Dados inválidos.';
        const raw = typeof response === 'object' && response !== null ? (response as { message?: unknown }).message : undefined;
        if (Array.isArray(raw)) details = { fields: raw };
      } else if (status === HttpStatus.NOT_FOUND) {
        code = 'NOT_FOUND';
        message = 'Recurso não encontrado.';
      } else if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
        code = 'PAYLOAD_TOO_LARGE';
        message = 'Arquivo ou requisição excede o tamanho permitido.';
      } else if (status === HttpStatus.UNAUTHORIZED) {
        code = 'UNAUTHENTICATED';
        message = 'Autenticação necessária.';
      } else if (status === HttpStatus.FORBIDDEN) {
        code = 'FORBIDDEN';
        message = 'Você não tem permissão para esta ação.';
      } else if (status < 500) {
        code = 'REQUEST_ERROR';
        message = 'Requisição inválida.';
      }
    } else if (isPrismaKnownError(exception) && exception.code === 'P2002') {
      status = HttpStatus.CONFLICT;
      code = 'CONFLICT';
      message = 'Registro já existe ou operação já foi realizada.';
    }

    if (status >= 500) {
      this.logger.error({
        event: 'unhandled_error',
        request_id: requestId,
        err: exception instanceof Error ? { name: exception.name, message: exception.message, stack: exception.stack } : String(exception),
      });
    }

    const body: ErrorBody = { error: { code, message, request_id: requestId, ...(details ? { details } : {}) } };
    if (code === 'RATE_LIMITED' && details && typeof details.retry_after_seconds === 'number') {
      res.setHeader('Retry-After', String(details.retry_after_seconds));
    }
    res.status(status).json(body);
  }
}
