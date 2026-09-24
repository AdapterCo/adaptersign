import { Module } from '@nestjs/common';
import { EnvelopesModule } from '../envelopes/envelopes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SigningController } from './signing.controller';
import { SigningService } from './signing.service';
import { OtpService } from './otp.service';
import { SignatureEngine } from './signature-engine';

@Module({
  imports: [EnvelopesModule, NotificationsModule],
  controllers: [SigningController],
  providers: [SigningService, OtpService, SignatureEngine],
  exports: [SignatureEngine],
})
export class SigningModule {}
