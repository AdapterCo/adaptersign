import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { EmailSenderService } from './email-sender.service';

@Module({
  providers: [NotificationsService, NotificationDispatcherService, EmailSenderService],
  exports: [NotificationsService, NotificationDispatcherService, EmailSenderService],
})
export class NotificationsModule {}
