import { Injectable, Logger } from '@nestjs/common';
import { ActorType, Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { canonicalJson } from '../../common/crypto/crypto.util';
import {
  GENESIS_HASH,
  chainKeyFor,
  computeEventHash,
  verifyChain,
  type ChainVerification,
  type StoredChainEvent,
} from './audit-chain';
import type { AuditEventTypeValue } from './audit-events';

export interface Actor {
  type: ActorType;
  id?: string | null;
}

export interface AuditInput {
  eventType: AuditEventTypeValue;
  actor: Actor;
  organizationId?: string | null;
  envelopeId?: string | null;
  documentId?: string | null;
  signerId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
  /** Horário do servidor; nunca usar horário fornecido pelo cliente. */
  occurredAt?: Date;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra evento append-only e encadeado. DEVE ser chamado dentro da mesma
   * transação da mudança de estado que ele descreve.
   */
  async record(tx: Tx, input: AuditInput): Promise<{ id: string; eventHash: string; sequence: number }> {
    const chainKey = chainKeyFor(input);
    // Serializa escritas por cadeia (evita forks sob concorrência).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chainKey}, 0))`;

    const last = await tx.auditEvent.findFirst({
      where: { chainKey },
      orderBy: { sequence: 'desc' },
      select: { sequence: true, eventHash: true },
    });
    const previousHash = last?.eventHash ?? GENESIS_HASH;
    const sequence = (last?.sequence ?? 0) + 1;
    // Normaliza metadata para que o JSON persistido seja exatamente o que foi hasheado.
    const metadata = JSON.parse(canonicalJson(input.metadata ?? {})) as Prisma.InputJsonObject;
    const occurredAt = input.occurredAt ?? new Date();

    const data = {
      chainKey,
      sequence,
      organizationId: input.organizationId ?? null,
      envelopeId: input.envelopeId ?? null,
      documentId: input.documentId ?? null,
      signerId: input.signerId ?? null,
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      eventType: input.eventType,
      occurredAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      metadata,
    };
    const eventHash = computeEventHash(previousHash, data);

    const created = await tx.auditEvent.create({
      data: { ...data, previousHash, eventHash },
      select: { id: true },
    });

    this.logger.log({
      event: 'audit_event',
      audit_event_type: input.eventType,
      organization_id: data.organizationId,
      envelope_id: data.envelopeId,
      request_id: data.requestId,
    });
    return { id: created.id, eventHash, sequence };
  }

  async recordStandalone(input: AuditInput): Promise<void> {
    await this.prisma.tx((tx) => this.record(tx, input));
  }

  async loadChain(chainKey: string, client: Tx | PrismaService = this.prisma): Promise<StoredChainEvent[]> {
    const rows = await client.auditEvent.findMany({ where: { chainKey }, orderBy: { sequence: 'asc' } });
    return rows.map((r) => ({
      chainKey: r.chainKey,
      sequence: r.sequence,
      organizationId: r.organizationId,
      envelopeId: r.envelopeId,
      documentId: r.documentId,
      signerId: r.signerId,
      actorType: r.actorType,
      actorId: r.actorId,
      eventType: r.eventType,
      occurredAt: r.occurredAt,
      ip: r.ip,
      userAgent: r.userAgent,
      requestId: r.requestId,
      metadata: r.metadata,
      previousHash: r.previousHash,
      eventHash: r.eventHash,
    }));
  }

  async verifyEnvelopeChain(envelopeId: string, client: Tx | PrismaService = this.prisma): Promise<ChainVerification> {
    return verifyChain(await this.loadChain(chainKeyFor({ envelopeId }), client));
  }
}
