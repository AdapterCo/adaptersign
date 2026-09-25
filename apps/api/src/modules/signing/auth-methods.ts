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

// WhatsApp depende de configuração (número central via Evolution API) — definido na inicialização.
let whatsappEnabled = false;

export function configureAuthMethods(opts: { whatsapp: boolean }): void {
  whatsappEnabled = opts.whatsapp;
}

export function isWhatsAppEnabled(): boolean {
  return whatsappEnabled;
}

function info(method: AuthMethod): AuthMethodInfo {
  const base = REGISTRY[method];
  if (method === AuthMethod.WHATSAPP_OTP && whatsappEnabled) {
    return { method, available: true, label: 'Código (OTP) enviado por WhatsApp' };
  }
  return base;
}

export function listAuthMethods(): AuthMethodInfo[] {
  return (Object.keys(REGISTRY) as AuthMethod[]).filter((m) => m !== AuthMethod.INTEGRATION).map(info);
}

export function assertAuthMethodAvailable(method: AuthMethod): void {
  const found = info(method);
  if (!found.available) {
    throw Errors.unprocessable('AUTH_METHOD_UNAVAILABLE', `Método de autenticação indisponível: ${found.label}.`, {
      method,
      reason: found.unavailableReason,
    });
  }
}

export function authMethodLabel(method: AuthMethod): string {
  return method === AuthMethod.WHATSAPP_OTP ? 'Código (OTP) enviado por WhatsApp' : REGISTRY[method].label;
}

/** Métodos que exigem desafio (código) antes de assinar. */
export function requiresChallenge(method: AuthMethod): boolean {
  return method === AuthMethod.EMAIL_OTP || method === AuthMethod.WHATSAPP_OTP;
}

export type OtpChannel = 'EMAIL' | 'WHATSAPP';

/**
 * Canais pelos quais o código pode ser enviado ao signatário:
 * - EMAIL_OTP ("código de verificação"): e-mail e, havendo telefone, WhatsApp;
 * - WHATSAPP_OTP: somente WhatsApp.
 */
export function otpChannels(signer: { authMethod: AuthMethod; phone: string | null }, whatsapp: boolean): OtpChannel[] {
  const wa = whatsapp && !!signer.phone;
  if (signer.authMethod === AuthMethod.WHATSAPP_OTP) return wa ? ['WHATSAPP'] : [];
  if (signer.authMethod === AuthMethod.EMAIL_OTP) return wa ? ['EMAIL', 'WHATSAPP'] : ['EMAIL'];
  return [];
}

/** O código vai, por padrão, pelo mesmo canal do link (links entregues pela API → WhatsApp, se houver). */
export function defaultOtpChannel(channels: OtpChannel[], linkChannel: string | null | undefined): OtpChannel | null {
  if (channels.length === 0) return null;
  if ((linkChannel === 'WHATSAPP' || linkChannel === 'API') && channels.includes('WHATSAPP')) return 'WHATSAPP';
  return channels.includes('EMAIL') ? 'EMAIL' : channels[0];
}

/** A sessão autenticada atende ao método exigido do signatário? */
export function sessionSatisfies(signerMethod: AuthMethod, sessionMethod: AuthMethod | null | undefined): boolean {
  if (signerMethod === AuthMethod.EMAIL_OTP) return sessionMethod === AuthMethod.EMAIL_OTP || sessionMethod === AuthMethod.WHATSAPP_OTP;
  if (signerMethod === AuthMethod.WHATSAPP_OTP) return sessionMethod === AuthMethod.WHATSAPP_OTP;
  return true;
}
