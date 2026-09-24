import { EnvelopeStatus, SignerStatus } from '../../generated/prisma/client';
import { AppError } from '../../common/errors/app-error';

// State machine centralizada (seção 75). Nenhuma mudança de status fora daqui.

export const ENVELOPE_TRANSITIONS: Record<EnvelopeStatus, readonly EnvelopeStatus[]> = {
  DRAFT: [EnvelopeStatus.ACTIVE, EnvelopeStatus.CANCELLED],
  ACTIVE: [EnvelopeStatus.PARTIALLY_SIGNED, EnvelopeStatus.COMPLETED, EnvelopeStatus.EXPIRED, EnvelopeStatus.CANCELLED, EnvelopeStatus.DECLINED],
  PARTIALLY_SIGNED: [EnvelopeStatus.COMPLETED, EnvelopeStatus.EXPIRED, EnvelopeStatus.CANCELLED, EnvelopeStatus.DECLINED],
  COMPLETED: [],
  EXPIRED: [],
  CANCELLED: [],
  DECLINED: [],
};

export const TERMINAL_ENVELOPE_STATUSES: readonly EnvelopeStatus[] = [
  EnvelopeStatus.COMPLETED,
  EnvelopeStatus.EXPIRED,
  EnvelopeStatus.CANCELLED,
  EnvelopeStatus.DECLINED,
];

/** Envelopes em que signatários podem atuar. */
export const SIGNABLE_ENVELOPE_STATUSES: readonly EnvelopeStatus[] = [EnvelopeStatus.ACTIVE, EnvelopeStatus.PARTIALLY_SIGNED];

export function canTransitionEnvelope(from: EnvelopeStatus, to: EnvelopeStatus): boolean {
  return ENVELOPE_TRANSITIONS[from].includes(to);
}

export function assertEnvelopeTransition(from: EnvelopeStatus, to: EnvelopeStatus): void {
  if (!canTransitionEnvelope(from, to)) {
    throw new AppError('INVALID_ENVELOPE_TRANSITION', `Transição de envelope não permitida: ${from} → ${to}.`, 409, { from, to });
  }
}

/** Estados de origem válidos para chegar a `to` (usado em UPDATE condicional). */
export function envelopeSourcesFor(to: EnvelopeStatus): EnvelopeStatus[] {
  return (Object.keys(ENVELOPE_TRANSITIONS) as EnvelopeStatus[]).filter((from) => ENVELOPE_TRANSITIONS[from].includes(to));
}

// Progresso do signatário: estados só avançam (nunca regridem).
const SIGNER_RANK: Record<SignerStatus, number> = {
  PENDING: 0,
  INVITED: 1,
  VIEWED: 2,
  AUTHENTICATED: 3,
  SIGNED: 10,
  DECLINED: 10,
  EXPIRED: 10,
};

export const TERMINAL_SIGNER_STATUSES: readonly SignerStatus[] = [SignerStatus.SIGNED, SignerStatus.DECLINED, SignerStatus.EXPIRED];

export function signerCanAdvance(from: SignerStatus, to: SignerStatus): boolean {
  if (TERMINAL_SIGNER_STATUSES.includes(from)) return false;
  if (to === SignerStatus.DECLINED || to === SignerStatus.EXPIRED) return from !== SignerStatus.PENDING || to === SignerStatus.EXPIRED;
  if (to === SignerStatus.SIGNED) return from === SignerStatus.AUTHENTICATED;
  return SIGNER_RANK[to] > SIGNER_RANK[from];
}

/** Estados de origem a partir dos quais o signatário pode ir para `to`. */
export function signerSourcesFor(to: SignerStatus): SignerStatus[] {
  return (Object.keys(SIGNER_RANK) as SignerStatus[]).filter((from) => signerCanAdvance(from, to));
}

/**
 * Grupos de assinatura: o grupo N só inicia quando todos os signatários
 * obrigatórios dos grupos < N concluíram. Retorna o próximo grupo a convidar, ou null.
 */
export function nextSigningGroup(
  signers: Array<{ signingGroup: number; status: SignerStatus; required: boolean }>,
): number | null {
  const groups = [...new Set(signers.map((s) => s.signingGroup))].sort((a, b) => a - b);
  for (const g of groups) {
    // Apenas signatários obrigatórios bloqueiam o avanço; opcionais não travam a sequência.
    const done = signers.filter((s) => s.signingGroup === g && s.required).every((s) => s.status === SignerStatus.SIGNED);
    if (!done) return g;
  }
  return null;
}

/** Signatários que devem estar convidados dado o grupo corrente (inclui opcionais de grupos anteriores). */
export function signersToInvite<T extends { id: string; signingGroup: number; status: SignerStatus }>(signers: T[], currentGroup: number | null): string[] {
  if (currentGroup === null) return [];
  return signers.filter((s) => s.signingGroup <= currentGroup && s.status === SignerStatus.PENDING).map((s) => s.id);
}

/** Um signatário pode atuar quando seu grupo já foi alcançado. */
export function isSignersTurn(signers: Array<{ signingGroup: number; status: SignerStatus; required: boolean }>, signingGroup: number): boolean {
  const current = nextSigningGroup(signers);
  return current !== null && signingGroup <= current;
}

export function allRequiredSigned(signers: Array<{ status: SignerStatus; required: boolean }>): boolean {
  return signers.length > 0 && signers.filter((s) => s.required).every((s) => s.status === SignerStatus.SIGNED);
}
