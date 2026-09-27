import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { EmailSenderService } from './email-sender.service';
import { PlanExpiryService } from './plan-expiry.service';

@Module({
  providers: [NotificationsService, NotificationDispatcherService, EmailSenderService, PlanExpiryService],
  exports: [NotificationsService, NotificationDispatcherService, EmailSenderService, PlanExpiryService],
})
export class NotificationsModule {}
