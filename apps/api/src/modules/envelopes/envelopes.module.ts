import { Module } from '@nestjs/common';
import { EnvelopesController } from './envelopes.controller';
import { EnvelopesService } from './envelopes.service';
import { EnvelopeLifecycleService } from './envelope-lifecycle.service';

@Module({
  controllers: [EnvelopesController],
  providers: [EnvelopesService, EnvelopeLifecycleService],
  exports: [EnvelopesService, EnvelopeLifecycleService],
})
export class EnvelopesModule {}
