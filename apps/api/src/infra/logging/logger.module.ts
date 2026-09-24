import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { getConfig } from '../../config/config';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Logs estruturados (JSON) com redação obrigatória de segredos:
 * nunca registrar senha, OTP, tokens, API keys, Authorization, cookies ou documentos.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.code',
  '*.otp',
  '*.secret',
  '*.key',
  '*.imageDataUrl',
  '*.accessToken',
  '*.refreshToken',
];

export function buildLoggerModule() {
  const config = getConfig();
  return LoggerModule.forRoot({
    pinoHttp: {
      level: config.LOG_LEVEL,
      // X-Request-ID: aceita o do proxy se bem formado; senão gera. Devolvido na resposta.
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-ID', id);
        return id;
      },
      customProps: (req: IncomingMessage) => ({ request_id: (req as IncomingMessage & { id?: string }).id }),
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        // URL sem query string (evita vazar tokens em parâmetros).
        req: (req: { id?: string; method?: string; url?: string }) => ({ id: req.id, method: req.method, path: req.url?.split('?')[0] }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' || req.url === '/ready' },
      transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  });
}
