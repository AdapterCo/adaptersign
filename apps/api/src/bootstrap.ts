import { RequestMethod, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { AppConfig } from './config/config';
import { GlobalExceptionFilter } from './common/errors/http-exception.filter';
import { csrfOriginCheck } from './common/http/csrf.middleware';
import { ACCESS_COOKIE } from './common/auth/tokens';

/** Configuração HTTP compartilhada entre produção (main.ts) e testes de integração. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  const isProd = config.NODE_ENV === 'production';

  // Atrás de Nginx/Traefik: número de proxies confiáveis (req.ip correto, sem spoofing).
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });

  const strictHelmet = helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });
  const docsHelmet = helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'] },
    },
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  app.use((req: { path: string }, res: unknown, next: () => void) =>
    (req.path.startsWith('/api/docs') ? docsHelmet : strictHelmet)(req as never, res as never, next),
  );
  app.use(cookieParser());

  const origins = [config.APP_PUBLIC_URL, ...config.CORS_ORIGINS];
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'Retry-After', 'Idempotent-Replayed', 'Content-Disposition'],
    maxAge: 600,
  });
  app.use(csrfOriginCheck(origins));

  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());

  if (config.SWAGGER_ENABLED) {
    const doc = new DocumentBuilder()
      .setTitle(`${config.BRAND_NAME} API`)
      .setDescription(
        'API REST versionada (/api/v1). Autenticação: cookie de sessão (aplicação web) ou API key via ' +
          '`Authorization: Bearer <key>`. Erros seguem o formato `{ "error": { "code", "message", "request_id" } }`. ' +
          'Operações críticas aceitam o cabeçalho `Idempotency-Key`.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'API key da organização' })
      .addCookieAuth(ACCESS_COOKIE)
      .addServer(config.API_PUBLIC_URL)
      .build();
    const document = SwaggerModule.createDocument(app, doc);
    SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
}
