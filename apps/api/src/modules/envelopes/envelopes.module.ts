import { Module } from '@nestjs/common';
import { TemplatesModule } from '../templates/templates.module';
import { EnvelopesController } from './envelopes.controller';
import { EnvelopesService } from './envelopes.service';
import { EnvelopeLifecycleService } from './envelope-lifecycle.service';

@Module({
  imports: [TemplatesModule],
  controllers: [EnvelopesController],
  providers: [EnvelopesService, EnvelopeLifecycleService],
  exports: [EnvelopesService, EnvelopeLifecycleService],
})
export class EnvelopesModule {}
