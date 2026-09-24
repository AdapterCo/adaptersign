import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { buildLoggerModule } from '../infra/logging/logger.module';
import { InfraModule } from '../infra/infra.module';
import { CoreModule } from '../modules/core.module';
import { EnvelopesModule } from '../modules/envelopes/envelopes.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';
import { EvidenceModule } from '../modules/evidence/evidence.module';
import { WorkerService } from './worker.service';

@Module({
  imports: [ConfigModule, buildLoggerModule(), InfraModule, CoreModule, EnvelopesModule, NotificationsModule, WebhooksModule, EvidenceModule],
  providers: [WorkerService],
})
export class WorkerModule {}
