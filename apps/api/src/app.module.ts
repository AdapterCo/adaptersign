import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { getConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { buildLoggerModule } from './infra/logging/logger.module';
import { InfraModule } from './infra/infra.module';
import { CoreModule } from './modules/core.module';
import { AuthGuard } from './common/auth/auth.guard';
import { RateLimitGuard } from './common/rate-limit/rate-limit';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { EnvelopesModule } from './modules/envelopes/envelopes.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { SigningModule } from './modules/signing/signing.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { VerifyModule } from './modules/verify/verify.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';

@Module({
  imports: [
    ConfigModule,
    buildLoggerModule(),
    InfraModule,
    CoreModule,
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({ secret: getConfig().JWT_ACCESS_SECRET, signOptions: { algorithm: 'HS256' } }),
    }),
    AuthModule,
    OrganizationsModule,
    DocumentsModule,
    TemplatesModule,
    EnvelopesModule,
    SigningModule,
    NotificationsModule,
    WebhooksModule,
    ApiKeysModule,
    VerifyModule,
    AdminModule,
    HealthModule,
    DashboardModule,
  ],
  providers: [
    // Ordem importa: autenticação → rate limit (usa identidade resolvida).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
