import { AuthMethod } from '../../generated/prisma/client';
import { Errors } from '../../common/errors/app-error';

export interface AuthMethodInfo {
  method: AuthMethod;
  available: boolean;
  label: string;
  /** Motivo da indisponibilidade (exibido explicitamente na UI; nunca simulado). */
  unavailableReason?: string;
}

/**
 * Registro de métodos de autenticação do signatário. Um método só é habilitado
 * quando existe integração real implementada. Feature flags NÃO habilitam métodos
 * sem implementação.
 */
const REGISTRY: Record<AuthMethod, AuthMethodInfo> = {
  EMAIL: { method: AuthMethod.EMAIL, available: true, label: 'Link individual enviado por e-mail' },
  EMAIL_OTP: { method: AuthMethod.EMAIL_OTP, available: true, label: 'Código (OTP) enviado por e-mail' },
  SMS_OTP: { method: AuthMethod.SMS_OTP, available: false, label: 'Código por SMS', unavailableReason: 'Integração de SMS ainda não implementada.' },
  WHATSAPP_OTP: {
    method: AuthMethod.WHATSAPP_OTP,
    available: false,
    label: 'Código por WhatsApp',
    unavailableReason: 'Integração de WhatsApp ainda não implementada.',
  },
  DOCUMENT: { method: AuthMethod.DOCUMENT, available: false, label: 'Documento de identidade', unavailableReason: 'Ainda não disponível.' },
  SELFIE: { method: AuthMethod.SELFIE, available: false, label: 'Selfie', unavailableReason: 'Ainda não disponível.' },
  BIOMETRICS: { method: AuthMethod.BIOMETRICS, available: false, label: 'Biometria', unavailableReason: 'Ainda não disponível.' },
  CERTIFICATE: { method: AuthMethod.CERTIFICATE, available: false, label: 'Certificado digital', unavailableReason: 'Ainda não disponível.' },
  ICP_BRASIL: { method: AuthMethod.ICP_BRASIL, available: false, label: 'Certificado ICP-Brasil', unavailableReason: 'Previsto para fase posterior.' },
  // Nunca escolhido manualmente: atribuído aos papéis da empresa em contratos criados pela integração.
  INTEGRATION: {
    method: AuthMethod.INTEGRATION,
    available: false,
    label: 'Integração autorizada da empresa (representante identificado pelo sistema de origem)',
    unavailableReason: 'Atribuído automaticamente ao papel da empresa em contratos enviados pela integração.',
  },
};

export function listAuthMethods(): AuthMethodInfo[] {
  return Object.values(REGISTRY).filter((m) => m.method !== AuthMethod.INTEGRATION);
}

export function assertAuthMethodAvailable(method: AuthMethod): void {
  const info = REGISTRY[method];
  if (!info.available) {
    throw Errors.unprocessable('AUTH_METHOD_UNAVAILABLE', `Método de autenticação indisponível: ${info.label}.`, {
      method,
      reason: info.unavailableReason,
    });
  }
}

export function authMethodLabel(method: AuthMethod): string {
  return REGISTRY[method].label;
}

/** Métodos que exigem desafio (código) antes de assinar. */
export function requiresChallenge(method: AuthMethod): boolean {
  return method === AuthMethod.EMAIL_OTP;
}
