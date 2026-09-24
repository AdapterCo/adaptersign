import { canonicalJson, sha256Hex } from '../../common/crypto/crypto.util';

export const GENESIS_HASH = '0'.repeat(64);

/** Campos que entram no hash (tudo o que é persistido, exceto id e os próprios hashes). */
export interface ChainedEventData {
  chainKey: string;
  sequence: number;
  organizationId: string | null;
  envelopeId: string | null;
  documentId: string | null;
  signerId: string | null;
  actorType: string;
  actorId: string | null;
  eventType: string;
  occurredAt: Date;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: unknown;
}

export function canonicalEventData(e: ChainedEventData): string {
  return canonicalJson({
    chainKey: e.chainKey,
    sequence: e.sequence,
    organizationId: e.organizationId,
    envelopeId: e.envelopeId,
    documentId: e.documentId,
    signerId: e.signerId,
    actorType: e.actorType,
    actorId: e.actorId,
    eventType: e.eventType,
    occurredAt: e.occurredAt.toISOString(),
    ip: e.ip,
    userAgent: e.userAgent,
    requestId: e.requestId,
    metadata: e.metadata ?? {},
  });
}

/** event_hash = SHA256(previous_hash + canonical_event_data) */
export function computeEventHash(previousHash: string, e: ChainedEventData): string {
  return sha256Hex(previousHash + canonicalEventData(e));
}

export interface StoredChainEvent extends ChainedEventData {
  previousHash: string;
  eventHash: string;
}

export interface ChainVerification {
  valid: boolean;
  count: number;
  headHash: string;
  failure?: { sequence: number; reason: 'SEQUENCE_GAP' | 'PREVIOUS_HASH_MISMATCH' | 'EVENT_HASH_MISMATCH' };
}

/** Recalcula toda a cadeia (eventos em ordem de sequence). Nunca oculta falhas. */
export function verifyChain(events: StoredChainEvent[]): ChainVerification {
  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const ev of events) {
    if (ev.sequence !== expectedSeq) {
      return { valid: false, count: events.length, headHash: expectedPrev, failure: { sequence: ev.sequence, reason: 'SEQUENCE_GAP' } };
    }
    if (ev.previousHash !== expectedPrev) {
      return { valid: false, count: events.length, headHash: expectedPrev, failure: { sequence: ev.sequence, reason: 'PREVIOUS_HASH_MISMATCH' } };
    }
    const recomputed = computeEventHash(ev.previousHash, ev);
    if (recomputed !== ev.eventHash) {
      return { valid: false, count: events.length, headHash: expectedPrev, failure: { sequence: ev.sequence, reason: 'EVENT_HASH_MISMATCH' } };
    }
    expectedPrev = ev.eventHash;
    expectedSeq++;
  }
  return { valid: true, count: events.length, headHash: expectedPrev };
}

export function chainKeyFor(input: { envelopeId?: string | null; organizationId?: string | null }): string {
  if (input.envelopeId) return `envelope:${input.envelopeId}`;
  if (input.organizationId) return `org:${input.organizationId}`;
  return 'platform';
}
