import { Module } from '@nestjs/common';
import { TemplatesModule } from '../templates/templates.module';
import { EnvelopesController } from './envelopes.controller';
import { EnvelopesService } from './envelopes.service';
import { EnvelopeLifecycleService } from './envelope-lifecycle.service';
import { CpfIndexBackfill } from './cpf-index.backfill';

@Module({
  imports: [TemplatesModule],
  controllers: [EnvelopesController],
  providers: [EnvelopesService, EnvelopeLifecycleService, CpfIndexBackfill],
  exports: [EnvelopesService, EnvelopeLifecycleService],
})
export class EnvelopesModule {}
