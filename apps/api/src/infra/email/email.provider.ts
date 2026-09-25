import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  messageId: string | null;
}

/** Abstração do provedor de e-mail (SMTP hoje; SES/Resend via SMTP ou adaptador próprio). */
export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/**
 * Provedor SMTP real (nodemailer). Funciona com Amazon SES SMTP, Resend SMTP,
 * servidores próprios e, em desenvolvimento, com Mailpit (docker-compose).
 */
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.from = config.EMAIL_FROM;
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      // Porta 587 (SMTP_SECURE=false): em produção exige STARTTLS — nunca envia credenciais sem TLS.
      requireTLS: config.NODE_ENV === 'production' && !config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } : undefined,
    });
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
    });
    return { messageId: typeof info.messageId === 'string' ? info.messageId : null };
  }
}
