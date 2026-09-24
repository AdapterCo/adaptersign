import { Module } from '@nestjs/common';
import { FinalizationService } from './finalization.service';

@Module({
  providers: [FinalizationService],
  exports: [FinalizationService],
})
export class EvidenceModule {}
