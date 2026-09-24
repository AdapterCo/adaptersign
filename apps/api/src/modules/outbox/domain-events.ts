// Eventos de domínio. Notificações e webhooks REAGEM a eles (via outbox + worker),
// sem acoplamento direto com os serviços que mudam estado.

export const DomainEvent = {
  ENVELOPE_CREATED: 'envelope.created',
  ENVELOPE_ACTIVATED: 'envelope.activated',
  DOCUMENT_VIEWED: 'document.viewed',
  SIGNER_AUTHENTICATED: 'signer.authenticated',
  SIGNER_SIGNED: 'signer.signed',
  SIGNER_DECLINED: 'signer.declined',
  ENVELOPE_COMPLETED: 'envelope.completed',
  ENVELOPE_EXPIRED: 'envelope.expired',
  ENVELOPE_CANCELLED: 'envelope.cancelled',
  // Internos (não expostos como webhook)
  SIGNERS_INVITE_REQUESTED: 'internal.signers.invite_requested',
  ENVELOPE_FINALIZATION_REQUESTED: 'internal.envelope.finalization_requested',
  USER_EMAIL_VERIFICATION_REQUESTED: 'internal.user.email_verification_requested',
  USER_PASSWORD_RESET_REQUESTED: 'internal.user.password_reset_requested',
} as const;

export type DomainEventType = (typeof DomainEvent)[keyof typeof DomainEvent];

/** Eventos que podem ser assinados por clientes via webhook. */
export const PUBLIC_WEBHOOK_EVENTS: readonly string[] = [
  DomainEvent.ENVELOPE_CREATED,
  DomainEvent.ENVELOPE_ACTIVATED,
  DomainEvent.DOCUMENT_VIEWED,
  DomainEvent.SIGNER_AUTHENTICATED,
  DomainEvent.SIGNER_SIGNED,
  DomainEvent.SIGNER_DECLINED,
  DomainEvent.ENVELOPE_COMPLETED,
  DomainEvent.ENVELOPE_EXPIRED,
  DomainEvent.ENVELOPE_CANCELLED,
];

export interface EnvelopeEventPayload {
  envelopeId: string;
  signerId?: string;
  documentId?: string;
}

export interface InviteRequestedPayload {
  envelopeId: string;
  signerIds: string[];
  kind: 'invite' | 'reminder';
}

export interface UserTokenEmailPayload {
  userId: string;
  /** Token em claro NÃO é persistido; o worker gera um novo token no envio. */
}
