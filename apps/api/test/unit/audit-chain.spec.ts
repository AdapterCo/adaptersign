import { canonicalJson, sha256Hex } from '../../src/common/crypto/crypto.util';
import { computeEventHash, GENESIS_HASH, verifyChain, type ChainedEventData, type StoredChainEvent } from '../../src/modules/audit/audit-chain';

function event(sequence: number, overrides: Partial<ChainedEventData> = {}): ChainedEventData {
  return {
    chainKey: 'envelope:00000000-0000-0000-0000-000000000001',
    sequence,
    organizationId: '00000000-0000-0000-0000-0000000000aa',
    envelopeId: '00000000-0000-0000-0000-000000000001',
    documentId: null,
    signerId: null,
    actorType: 'SYSTEM',
    actorId: null,
    eventType: 'TEST_EVENT',
    occurredAt: new Date(Date.UTC(2026, 8, 23, 22, 35, 18, 123)),
    ip: null,
    userAgent: null,
    requestId: null,
    metadata: { b: 2, a: 1 },
    ...overrides,
  };
}

function buildChain(n: number): StoredChainEvent[] {
  const out: StoredChainEvent[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const e = event(i, { metadata: { index: i } });
    const eventHash = computeEventHash(prev, e);
    out.push({ ...e, previousHash: prev, eventHash });
    prev = eventHash;
  }
  return out;
}

describe('canonicalJson', () => {
  it('é determinístico independentemente da ordem das propriedades', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('normaliza Date, bigint e omite undefined', () => {
    expect(canonicalJson({ d: new Date('2026-09-23T22:35:18.123Z'), n: 10n, u: undefined })).toBe('{"d":"2026-09-23T22:35:18.123Z","n":"10"}');
  });

  it('rejeita números não finitos', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});

describe('encadeamento de auditoria', () => {
  it('event_hash = SHA256(previous_hash + canonical_event_data)', () => {
    const e = event(1);
    const hash = computeEventHash(GENESIS_HASH, e);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEventHash(GENESIS_HASH, { ...e, metadata: { a: 1, b: 2 } })).toBe(hash);
    expect(hash).toBe(sha256Hex(GENESIS_HASH + canonicalJson({
      actorId: null, actorType: 'SYSTEM', chainKey: e.chainKey, documentId: null, envelopeId: e.envelopeId, eventType: 'TEST_EVENT',
      ip: null, metadata: { a: 1, b: 2 }, occurredAt: e.occurredAt.toISOString(), organizationId: e.organizationId,
      requestId: null, sequence: 1, signerId: null, userAgent: null,
    })));
  });

  it('valida uma cadeia íntegra', () => {
    const result = verifyChain(buildChain(5));
    expect(result.valid).toBe(true);
    expect(result.count).toBe(5);
  });

  it('detecta adulteração de dados de um evento', () => {
    const chain = buildChain(4);
    chain[2] = { ...chain[2], metadata: { index: 999 } };
    expect(verifyChain(chain)).toMatchObject({ valid: false, failure: { sequence: 3, reason: 'EVENT_HASH_MISMATCH' } });
  });

  it('detecta remoção de evento (lacuna de sequência)', () => {
    const chain = buildChain(4);
    chain.splice(1, 1);
    expect(verifyChain(chain)).toMatchObject({ valid: false, failure: { reason: 'SEQUENCE_GAP' } });
  });

  it('detecta quebra de encadeamento (previous_hash)', () => {
    const chain = buildChain(3);
    chain[1] = { ...chain[1], previousHash: 'f'.repeat(64) };
    expect(verifyChain(chain).valid).toBe(false);
  });
});
