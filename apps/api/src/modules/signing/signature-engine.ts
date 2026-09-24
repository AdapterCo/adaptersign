import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ActorType,
  EnvelopeStatus,
  Prisma,
  SignatureMethod,
  SignerStatus,
  UsageMetric,
  type Envelope,
} from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { StorageKeys, StorageService } from '../../infra/storage/storage.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { sha256Hex } from '../../common/crypto/crypto.util';
import { Errors } from '../../common/errors/app-error';
import { cleanText } from '../../common/util/text';
import type { ClientInfo } from '../../common/http/client-info';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { OutboxService, type EmittedEvent } from '../outbox/outbox.service';
import { DomainEvent } from '../outbox/domain-events';
import { UsageService } from '../billing/usage.service';
import { LegalService } from '../legal/legal.service';
import {
  allRequiredSigned,
  isSignersTurn,
  nextSigningGroup,
  signersToInvite,
  SIGNABLE_ENVELOPE_STATUSES,
} from '../envelopes/envelope-state';
import { requiresChallenge } from './auth-methods';

export interface SignInput {
  consentAccepted: boolean;
  consentVersion: string;
  method: SignatureMethod;
  typedName?: string;
  imageDataUrl?: string;
  /** Hashes exibidos ao signatário (opcional); se enviados, precisam coincidir. */
  documentHashes?: Record<string, string>;
}

export interface SignContext {
  signatureSessionId: string;
  signerId: string;
  envelopeId: string;
  client: ClientInfo;
}

export interface SignResult {
  signatureId: string;
  signedAt: Date;
  idempotentReplay: boolean;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Motor de assinatura (seção 76). Independente da interface web: pode ser usado por
 * frontend, API, mobile ou integrações. Uma única transação cobre elegibilidade,
 * autenticação, consentimento, documento, registro, evidência, estado e auditoria.
 */
@Injectable()
export class SignatureEngine {
  private readonly logger = new Logger('SignatureEngine');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly usage: UsageService,
    private readonly legal: LegalService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Decodifica e valida imagem PNG da assinatura desenhada (sem confiar no cliente). */
  parseSignatureImage(dataUrl: string | undefined): Buffer {
    const prefix = 'data:image/png;base64,';
    if (!dataUrl || !dataUrl.startsWith(prefix)) throw Errors.validation('Assinatura desenhada inválida (PNG esperado).');
    const buf = Buffer.from(dataUrl.slice(prefix.length), 'base64');
    if (buf.length === 0 || buf.length > this.config.SIGNATURE_IMAGE_MAX_BYTES) {
      throw Errors.validation('Imagem da assinatura vazia ou grande demais.');
    }
    if (!buf.subarray(0, 8).equals(PNG_MAGIC) || buf.length < 24) throw Errors.validation('Imagem da assinatura não é um PNG válido.');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width < 10 || height < 10 || width > 2000 || height > 1000) throw Errors.validation('Dimensões da assinatura inválidas.');
    return buf;
  }

  async sign(ctx: SignContext, input: SignInput): Promise<SignResult> {
    // Validações que não dependem do estado do banco.
    if (input.consentAccepted !== true) throw Errors.unprocessable('CONSENT_REQUIRED', 'É necessário aceitar os termos para assinar.');
    const consentText = await this.legal.currentSignatureConsent();
    if (input.consentVersion !== consentText.version) {
      throw Errors.unprocessable('CONSENT_VERSION_MISMATCH', 'O texto de aceite foi atualizado. Recarregue a página.');
    }
    let typedName: string | null = null;
    let image: Buffer | null = null;
    if (input.method === SignatureMethod.TYPED) {
      typedName = cleanText(input.typedName ?? '', 120);
      if (typedName.length < 2) throw Errors.validation('Digite seu nome para assinar.');
    } else if (input.method === SignatureMethod.DRAWN) {
      image = this.parseSignatureImage(input.imageDataUrl);
    } else {
      throw Errors.validation('Método de assinatura inválido.');
    }

    // Asset visual gravado antes da transação (chave única por tentativa; órfão removido em falha).
    const signerRow = await this.prisma.signer.findUniqueOrThrow({ where: { id: ctx.signerId }, select: { organizationId: true } });
    let assetKey: string | null = null;
    let assetSha256: string | null = null;
    if (image) {
      assetSha256 = sha256Hex(image);
      assetKey = StorageKeys.signatureAsset(signerRow.organizationId, ctx.envelopeId, `${ctx.signerId}-${randomUUID()}`);
      await this.storage.putImmutable(assetKey, image, 'image/png', assetSha256);
    }

    try {
      const outcome = await this.prisma.tx((tx) => this.signTx(tx, ctx, input, consentText, typedName, assetKey, assetSha256), 20000);
      if (outcome.replay && assetKey) await this.storage.deleteOrphan(assetKey).catch(() => undefined);
      await this.outbox.dispatch(outcome.events);
      return outcome.result;
    } catch (err) {
      if (assetKey) await this.storage.deleteOrphan(assetKey).catch(() => undefined);
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
        throw Errors.conflict('ALREADY_SIGNED', 'Este signatário já assinou.');
      }
      throw err;
    }
  }

  private async signTx(
    tx: Tx,
    ctx: SignContext,
    input: SignInput,
    consentText: { id: string; version: string; sha256: string },
    typedName: string | null,
    assetKey: string | null,
    assetSha256: string | null,
  ): Promise<{ result: SignResult; events: EmittedEvent[]; replay: boolean }> {
    // 1. Locks (envelope, depois signatário) — ordem fixa evita deadlock.
    await tx.$queryRaw`SELECT "id" FROM "envelopes" WHERE "id" = ${ctx.envelopeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "signers" WHERE "id" = ${ctx.signerId}::uuid FOR UPDATE`;
    const envelope = await tx.envelope.findUniqueOrThrow({ where: { id: ctx.envelopeId } });
    const signer = await tx.signer.findUniqueOrThrow({ where: { id: ctx.signerId }, include: { signature: true } });
    const session = await tx.signatureSession.findUniqueOrThrow({ where: { id: ctx.signatureSessionId } });

    // 2. Idempotência: repetição da mesma requisição não cria segunda assinatura.
    if (signer.signature) {
      if (signer.signature.signatureSessionId === session.id) {
        return {
          result: { signatureId: signer.signature.id, signedAt: signer.signature.signedAt, idempotentReplay: true },
          events: [],
          replay: true,
        };
      }
      throw Errors.conflict('ALREADY_SIGNED', 'Este signatário já assinou.');
    }

    // 3. Elegibilidade.
    const now = new Date();
    if (signer.envelopeId !== envelope.id || session.signerId !== signer.id || session.envelopeId !== envelope.id) throw Errors.forbidden();
    if (!SIGNABLE_ENVELOPE_STATUSES.includes(envelope.status) || envelope.finalizationRequestedAt) {
      throw Errors.conflict('ENVELOPE_NOT_SIGNABLE', 'Este envelope não aceita mais assinaturas.');
    }
    if (envelope.expiresAt && envelope.expiresAt <= now) throw Errors.conflict('ENVELOPE_EXPIRED', 'Este envelope expirou.');
    if (session.revokedAt || session.expiresAt <= now) throw Errors.unauthenticated('Sessão de assinatura expirada.');
    const signers = await tx.signer.findMany({ where: { envelopeId: envelope.id } });
    if (!isSignersTurn(signers, signer.signingGroup)) {
      throw Errors.conflict('NOT_YOUR_TURN', 'Ainda não é a sua vez de assinar.');
    }

    // 4. Autenticação.
    if (!session.authenticatedAt || signer.status !== SignerStatus.AUTHENTICATED) {
      throw Errors.unprocessable('AUTHENTICATION_REQUIRED', 'Autenticação necessária antes de assinar.');
    }
    if (requiresChallenge(signer.authMethod) && session.authMethod !== signer.authMethod) {
      throw Errors.unprocessable('AUTHENTICATION_REQUIRED', 'Autenticação necessária antes de assinar.');
    }

    // 5. Documentos (hash do original travado no envelope).
    const docs = await tx.envelopeDocument.findMany({
      where: { envelopeId: envelope.id },
      orderBy: { position: 'asc' },
      include: { documentVersion: { select: { id: true, documentId: true, sha256: true, filename: true } } },
    });
    for (const d of docs) {
      if (d.documentVersion.sha256 !== d.originalSha256) throw new Error(`Inconsistência de hash no documento ${d.id}`);
      const shown = input.documentHashes?.[d.id];
      if (shown !== undefined && shown !== d.originalSha256) {
        throw Errors.unprocessable('DOCUMENT_HASH_MISMATCH', 'O documento exibido não corresponde ao documento do envelope.');
      }
    }
    const documentHashes = docs.map((d) => ({
      envelopeDocumentId: d.id,
      documentId: d.documentVersion.documentId,
      versionId: d.documentVersion.id,
      filename: d.documentVersion.filename,
      sha256: d.originalSha256,
    }));

    const actor = { type: ActorType.SIGNER, id: signer.id };
    const base = { actor, organizationId: envelope.organizationId, envelopeId: envelope.id, signerId: signer.id, ...ctx.client };
    await this.audit.record(tx, { ...base, eventType: AuditEventType.SIGNATURE_STARTED, occurredAt: now, metadata: { method: input.method } });

    // 6. Consentimento versionado.
    const consent = await tx.consent.create({
      data: {
        organizationId: envelope.organizationId,
        envelopeId: envelope.id,
        signerId: signer.id,
        legalTextVersionId: consentText.id,
        accepted: true,
        documentHashes: documentHashes as unknown as Prisma.InputJsonArray,
        ip: ctx.client.ip,
        userAgent: ctx.client.userAgent,
      },
    });
    await this.audit.record(tx, {
      ...base,
      eventType: AuditEventType.CONSENT_ACCEPTED,
      occurredAt: now,
      metadata: { consentId: consent.id, termsVersion: consentText.version, termsSha256: consentText.sha256, documents: documentHashes },
    });

    // 7. Evidência consolidada + registro da assinatura (unique signer_id).
    const evidence = {
      event: 'SIGNATURE_COMPLETED',
      signer_id: signer.id,
      envelope_id: envelope.id,
      documents: documentHashes.map((d) => ({ document_id: d.documentId, version_id: d.versionId, sha256: d.sha256 })),
      timestamp: now.toISOString(),
      authentication: { method: signer.authMethod, authenticated_at: session.authenticatedAt.toISOString(), session_id: session.id },
      network: { ip: ctx.client.ip, user_agent: ctx.client.userAgent },
      consent: { accepted: true, terms_version: consentText.version, terms_sha256: consentText.sha256, consent_id: consent.id },
      signature: { method: input.method, asset_sha256: assetSha256 },
      signer: { role: signer.role, signing_group: signer.signingGroup },
    };
    const signature = await tx.signature.create({
      data: {
        organizationId: envelope.organizationId,
        envelopeId: envelope.id,
        signerId: signer.id,
        consentId: consent.id,
        signatureSessionId: session.id,
        method: input.method,
        typedName,
        assetStorageKey: assetKey,
        assetSha256,
        authMethod: signer.authMethod,
        evidence: evidence as Prisma.InputJsonObject,
        ip: ctx.client.ip,
        userAgent: ctx.client.userAgent,
        signedAt: now,
      },
    });
    const updated = await tx.signer.updateMany({
      where: { id: signer.id, status: SignerStatus.AUTHENTICATED },
      data: { status: SignerStatus.SIGNED, signedAt: now },
    });
    if (updated.count !== 1) throw Errors.conflict('SIGNER_STATE_CHANGED', 'Estado do signatário mudou. Tente novamente.');
    await this.usage.increment(tx, envelope.organizationId, UsageMetric.SIGNATURES_COMPLETED, 1);
    await this.audit.record(tx, {
      ...base,
      eventType: AuditEventType.SIGNATURE_COMPLETED,
      occurredAt: now,
      metadata: { signatureId: signature.id, method: input.method, assetSha256, authMethod: signer.authMethod, consentId: consent.id },
    });

    const events: EmittedEvent[] = [
      await this.outbox.emit(tx, {
        type: DomainEvent.SIGNER_SIGNED,
        organizationId: envelope.organizationId,
        payload: { envelopeId: envelope.id, signerId: signer.id },
        requestId: ctx.client.requestId,
      }),
    ];

    // 8. Avaliação de conclusão / próximo grupo.
    events.push(...(await this.evaluateProgress(tx, envelope, ctx.client)));

    return { result: { signatureId: signature.id, signedAt: now, idempotentReplay: false }, events, replay: false };
  }

  /**
   * Após um signatário chegar a estado terminal: solicita finalização (se todos os
   * obrigatórios assinaram) ou convida o próximo grupo. Nunca marca COMPLETED aqui —
   * a finalização atômica (com evidências) é responsabilidade do FinalizationService.
   */
  async evaluateProgress(tx: Tx, envelope: Envelope, client: ClientInfo): Promise<EmittedEvent[]> {
    const signers = await tx.signer.findMany({ where: { envelopeId: envelope.id } });
    const events: EmittedEvent[] = [];
    const anySigned = signers.some((s) => s.status === SignerStatus.SIGNED);

    if (allRequiredSigned(signers)) {
      const now = new Date();
      await tx.envelope.update({
        where: { id: envelope.id },
        data: {
          finalizationRequestedAt: now,
          ...(envelope.status === EnvelopeStatus.ACTIVE ? { status: EnvelopeStatus.PARTIALLY_SIGNED } : {}),
        },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.ENVELOPE_FINALIZATION_REQUESTED,
        actor: { type: ActorType.SYSTEM },
        organizationId: envelope.organizationId,
        envelopeId: envelope.id,
        requestId: client.requestId,
        occurredAt: now,
        metadata: { signed: signers.filter((s) => s.status === SignerStatus.SIGNED).map((s) => s.id) },
      });
      events.push(
        await this.outbox.emit(tx, {
          type: DomainEvent.ENVELOPE_FINALIZATION_REQUESTED,
          organizationId: envelope.organizationId,
          payload: { envelopeId: envelope.id },
          requestId: client.requestId,
        }),
      );
      return events;
    }

    if (anySigned && envelope.status === EnvelopeStatus.ACTIVE) {
      await tx.envelope.update({ where: { id: envelope.id }, data: { status: EnvelopeStatus.PARTIALLY_SIGNED } });
    }
    const toInvite = signersToInvite(signers, nextSigningGroup(signers));
    if (toInvite.length > 0) {
      events.push(
        await this.outbox.emit(tx, {
          type: DomainEvent.SIGNERS_INVITE_REQUESTED,
          organizationId: envelope.organizationId,
          payload: { envelopeId: envelope.id, signerIds: toInvite, kind: 'invite' },
          requestId: client.requestId,
        }),
      );
    }
    return events;
  }
}
