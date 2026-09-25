import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { EnvelopesModule } from '../envelopes/envelopes.module';
import { SigningModule } from '../signing/signing.module';
import { TemplatesModule } from '../templates/templates.module';
import { IntegrationsController } from './integrations.controller';
import { ContractsService } from './contracts.service';
import { CompanySignatureService } from './company-signature.service';

@Module({
  imports: [DocumentsModule, EnvelopesModule, SigningModule, TemplatesModule],
  controllers: [IntegrationsController],
  providers: [ContractsService, CompanySignatureService],
})
export class IntegrationsModule {}
