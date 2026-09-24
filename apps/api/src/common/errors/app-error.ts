import { HttpStatus } from '@nestjs/common';

// Erro de domínio com código estável (consumido por frontend e integrações).
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = HttpStatus.BAD_REQUEST,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError('VALIDATION_ERROR', message, HttpStatus.BAD_REQUEST, details),
  unauthenticated: (message = 'Autenticação necessária.') =>
    new AppError('UNAUTHENTICATED', message, HttpStatus.UNAUTHORIZED),
  forbidden: (message = 'Você não tem permissão para esta ação.') =>
    new AppError('FORBIDDEN', message, HttpStatus.FORBIDDEN),
  notFound: (code: string, message: string) => new AppError(code, message, HttpStatus.NOT_FOUND),
  conflict: (code: string, message: string) => new AppError(code, message, HttpStatus.CONFLICT),
  unprocessable: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError('RATE_LIMITED', 'Muitas tentativas. Aguarde e tente novamente.', HttpStatus.TOO_MANY_REQUESTS, {
      retry_after_seconds: retryAfterSeconds,
    }),
  planLimit: (message: string, details?: Record<string, unknown>) =>
    new AppError('PLAN_LIMIT_REACHED', message, HttpStatus.PAYMENT_REQUIRED, details),
  unavailable: (code: string, message: string) => new AppError(code, message, HttpStatus.SERVICE_UNAVAILABLE),
};
