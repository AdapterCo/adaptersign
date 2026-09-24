import { EnvelopeStatus, SignerStatus } from '../../src/generated/prisma/client';
import {
  allRequiredSigned,
  assertEnvelopeTransition,
  canTransitionEnvelope,
  isSignersTurn,
  nextSigningGroup,
  signerCanAdvance,
  signersToInvite,
} from '../../src/modules/envelopes/envelope-state';

describe('state machine de envelope', () => {
  it('permite apenas transições definidas', () => {
    expect(canTransitionEnvelope(EnvelopeStatus.DRAFT, EnvelopeStatus.ACTIVE)).toBe(true);
    expect(canTransitionEnvelope(EnvelopeStatus.DRAFT, EnvelopeStatus.COMPLETED)).toBe(false);
    expect(canTransitionEnvelope(EnvelopeStatus.ACTIVE, EnvelopeStatus.PARTIALLY_SIGNED)).toBe(true);
    expect(canTransitionEnvelope(EnvelopeStatus.PARTIALLY_SIGNED, EnvelopeStatus.ACTIVE)).toBe(false);
  });

  it('estados terminais não têm saída', () => {
    for (const s of [EnvelopeStatus.COMPLETED, EnvelopeStatus.CANCELLED, EnvelopeStatus.EXPIRED, EnvelopeStatus.DECLINED]) {
      for (const t of Object.values(EnvelopeStatus)) expect(canTransitionEnvelope(s, t)).toBe(false);
    }
  });

  it('lança erro com código estável em transição inválida', () => {
    expect(() => assertEnvelopeTransition(EnvelopeStatus.COMPLETED, EnvelopeStatus.CANCELLED)).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVELOPE_TRANSITION' }),
    );
  });
});

describe('progresso do signatário', () => {
  it('não regride e só assina após autenticar', () => {
    expect(signerCanAdvance(SignerStatus.AUTHENTICATED, SignerStatus.VIEWED)).toBe(false);
    expect(signerCanAdvance(SignerStatus.INVITED, SignerStatus.SIGNED)).toBe(false);
    expect(signerCanAdvance(SignerStatus.AUTHENTICATED, SignerStatus.SIGNED)).toBe(true);
    expect(signerCanAdvance(SignerStatus.SIGNED, SignerStatus.DECLINED)).toBe(false);
    expect(signerCanAdvance(SignerStatus.PENDING, SignerStatus.DECLINED)).toBe(false);
  });
});

describe('ordem de assinatura (grupos)', () => {
  const s = (id: string, signingGroup: number, status: SignerStatus, required = true) => ({ id, signingGroup, status, required });

  it('sequencial: Daniel -> João -> Maria', () => {
    const signers = [s('daniel', 1, SignerStatus.INVITED), s('joao', 2, SignerStatus.PENDING), s('maria', 3, SignerStatus.PENDING)];
    expect(nextSigningGroup(signers)).toBe(1);
    expect(isSignersTurn(signers, 2)).toBe(false);
    signers[0].status = SignerStatus.SIGNED;
    expect(nextSigningGroup(signers)).toBe(2);
    expect(signersToInvite(signers, 2)).toEqual(['joao']);
  });

  it('grupos: grupo 2 só começa após conclusão do grupo 1', () => {
    const signers = [s('a', 1, SignerStatus.SIGNED), s('b', 1, SignerStatus.INVITED), s('c', 2, SignerStatus.PENDING), s('d', 2, SignerStatus.PENDING)];
    expect(nextSigningGroup(signers)).toBe(1);
    signers[1].status = SignerStatus.SIGNED;
    expect(signersToInvite(signers, nextSigningGroup(signers))).toEqual(['c', 'd']);
  });

  it('signatário opcional não bloqueia a sequência', () => {
    const signers = [s('a', 1, SignerStatus.SIGNED), s('opt', 1, SignerStatus.INVITED, false), s('b', 2, SignerStatus.PENDING)];
    expect(nextSigningGroup(signers)).toBe(2);
    expect(isSignersTurn(signers, 1)).toBe(true);
  });

  it('conclusão exige todos os obrigatórios assinados', () => {
    expect(allRequiredSigned([s('a', 1, SignerStatus.SIGNED), s('b', 1, SignerStatus.INVITED, false)])).toBe(true);
    expect(allRequiredSigned([s('a', 1, SignerStatus.SIGNED), s('b', 1, SignerStatus.DECLINED)])).toBe(false);
    expect(allRequiredSigned([])).toBe(false);
  });
});
