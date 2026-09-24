import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { OutboxService } from './outbox/outbox.service';
import { RateLimitService } from '../common/rate-limit/rate-limit';
import { PlansService } from './billing/plans.service';
import { UsageService } from './billing/usage.service';
import { LimitsService } from './billing/limits.service';
import { BILLING_PROVIDER, ManualBillingProvider } from './billing/billing-provider';
import { LegalService } from './legal/legal.service';

/** Serviços transversais usados por API e worker. */
@Global()
@Module({
  providers: [
    AuditService,
    OutboxService,
    RateLimitService,
    PlansService,
    UsageService,
    LimitsService,
    LegalService,
    { provide: BILLING_PROVIDER, useClass: ManualBillingProvider },
  ],
  exports: [AuditService, OutboxService, RateLimitService, PlansService, UsageService, LimitsService, LegalService, BILLING_PROVIDER],
})
export class CoreModule {}
