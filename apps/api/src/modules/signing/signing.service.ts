import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { ActorType, AuthMethod, EnvelopeStatus, SignerStatus, type Envelope, type Signer, type SignatureSession } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageService } from '../../infra/storage/storage.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { randomToken } from '../../common/crypto/crypto.util';
import { Errors } from '../../common/errors/app-error';
import { maskEmail } from '../../common/util/mask';
import { maskPhone } from '../../common/util/phone';
import { cleanText } from '../../common/util/text';
import type { ClientInfo } from '../../common/http/client-info';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { OutboxService, type EmittedEvent } from '../outbox/outbox.service';
import { DomainEvent } from '../outbox/domain-events';
import { LegalService } from '../legal/legal.service';
import { EnvelopeLifecycleService } from '../envelopes/envelope-lifecycle.service';
import { EnvelopesService } from '../envelopes/envelopes.service';
import { isSignersTurn, SIGNABLE_ENVELOPE_STATUSES, signerSourcesFor } from '../envelopes/envelope-state';
import { authMethodLabel, defaultOtpChannel, isWhatsAppEnabled, otpChannels, requiresChallenge } from './auth-methods';
import { SignatureEngine } from './signature-engine';

export interface ResolvedSession {
  session: SignatureSession;
  signer: Signer;
  envelope: Envelope;
}

@Injectable()
export class SigningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly legal: LegalService,
    private readonly lifecycle: EnvelopeLifecycleService,
    private readonly envelopes: EnvelopesService,
    private readonly engine: SignatureEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Abre o link de convite: valida o token opaco e cria sessão restrita ao processo. */
  async openSession(rawToken: string, client: ClientInfo): Promise<{ sessionToken: string; ttlMs: number; state: Awaited<ReturnType<SigningService['state']>> }> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(rawToken)) throw Errors.unauthenticated('Link de assinatura inválido.');
    const tokenHash = this.encryption.hashToken(rawToken, 'signer_access');
    const access = await this.prisma.signerAccessToken.findUnique({
      where: { tokenHash },
      include: { signer: { include: { envelope: true } } },
    });
    const now = new Date();
    if (!access || access.revokedAt || access.expiresAt <= now) throw Errors.unauthenticated('Link de assinatura inválido ou expirado.');
    const { signer } = access;
    const envelope = signer.envelope;

    if (SIGNABLE_ENVELOPE_STATUSES.includes(envelope.status) && envelope.expiresAt && envelope.expiresAt <= now) {
      await this.lifecycle.expireEnvelope(envelope.id, client.requestId);
      throw Errors.conflict('ENVELOPE_EXPIRED', 'Este envelope expirou.');
    }
    if (envelope.status === EnvelopeStatus.DRAFT || envelope.status === EnvelopeStatus.CANCELLED || envelope.status === EnvelopeStatus.EXPIRED) {
      throw Errors.conflict('ENVELOPE_NOT_AVAILABLE', 'Este processo de assinatura não está disponível.');
    }

    const sessionToken = randomToken(32);
    const ttlMs = this.config.SIGNATURE_SESSION_TTL_MINUTES * 60 * 1000;
    const autoAuth = signer.authMethod === AuthMethod.EMAIL && SIGNABLE_ENVELOPE_STATUSES.includes(envelope.status);
    const events: EmittedEvent[] = [];

    const session = await this.prisma.tx(async (tx) => {
      const s = await tx.signatureSession.create({
        data: {
          signerId: signer.id,
          envelopeId: envelope.id,
          tokenHash: this.encryption.hashToken(sessionToken, 'sign_session'),
          ip: client.ip,
          userAgent: client.userAgent,
          expiresAt: new Date(now.getTime() + ttlMs),
          linkChannel: access.channel,
          ...(autoAuth ? { authenticatedAt: now, authMethod: AuthMethod.EMAIL } : {}),
        },
      });
      await tx.signerAccessToken.update({ where: { id: access.id }, data: { lastUsedAt: now } });
      const base = {
        actor: { type: ActorType.SIGNER, id: signer.id },
        organizationId: envelope.organizationId,
        envelopeId: envelope.id,
        signerId: signer.id,
        ...client,
      };
      await this.audit.record(tx, { ...base, eventType: AuditEventType.INVITATION_OPENED, occurredAt: now, metadata: { sessionId: s.id } });
      if (autoAuth) {
        // Método EMAIL: a posse do link individual enviado ao e-mail é o fator de autenticação.
        await tx.signer.updateMany({
          where: { id: signer.id, status: { in: signerSourcesFor(SignerStatus.AUTHENTICATED) } },
          data: { status: SignerStatus.AUTHENTICATED, authenticatedAt: now },
        });
        await this.audit.record(tx, {
          ...base,
          eventType: AuditEventType.SIGNER_AUTHENTICATED,
          occurredAt: now,
          metadata: { method: AuthMethod.EMAIL, sessionId: s.id, accessTokenId: access.id },
        });
        events.push(
          await this.outbox.emit(tx, {
            type: DomainEvent.SIGNER_AUTHENTICATED,
            organizationId: envelope.organizationId,
            payload: { envelopeId: envelope.id, signerId: signer.id },
            requestId: client.requestId,
          }),
        );
      }
      return s;
    });
    await this.outbox.dispatch(events);
    const resolved = await this.load(session.id);
    return { sessionToken, ttlMs, state: await this.state(resolved) };
  }

  /** Resolve a sessão a partir do cookie. Nunca concede acesso ao dashboard. */
  async resolve(rawSessionToken: string | undefined): Promise<ResolvedSession> {
    if (!rawSessionToken) throw Errors.unauthenticated('Sessão de assinatura não encontrada. Abra novamente o link recebido.');
    const tokenHash = this.encryption.hashToken(rawSessionToken, 'sign_session');
    const session = await this.prisma.signatureSession.findUnique({ where: { tokenHash } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw Errors.unauthenticated('Sessão de assinatura expirada. Abra novamente o link recebido.');
    }
    return this.load(session.id);
  }

  private async load(sessionId: string): Promise<ResolvedSession> {
    const session = await this.prisma.signatureSession.findUniqueOrThrow({ where: { id: sessionId }, include: { signer: { include: { envelope: true } } } });
    const { signer, ...sessionOnly } = session;
    const { envelope, ...signerOnly } = signer;
    return { session: sessionOnly as SignatureSession, signer: signerOnly as Signer, envelope };
  }

  async state({ session, signer, envelope }: ResolvedSession) {
    const [org, docs, consent, signers, myFields] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: envelope.organizationId }, select: { name: true } }),
      this.prisma.envelopeDocument.findMany({
        where: { envelopeId: envelope.id },
        orderBy: { position: 'asc' },
        include: { documentVersion: { select: { filename: true, pageCount: true } } },
      }),
      this.legal.currentSignatureConsent(),
      this.prisma.signer.findMany({ where: { envelopeId: envelope.id }, select: { signingGroup: true, status: true, required: true } }),
      this.prisma.envelopeField.findMany({
        where: { envelopeId: envelope.id, signerId: signer.id },
        select: { envelopeDocumentId: true, type: true, page: true, x: true, y: true, width: true, height: true },
        orderBy: [{ page: 'asc' }, { y: 'asc' }],
      }),
    ]);
    const completed = envelope.status === EnvelopeStatus.COMPLETED;
    return {
      envelope: {
        title: envelope.title,
        message: envelope.message,
        status: envelope.status,
        organizationName: org.name,
        expiresAt: envelope.expiresAt,
        validationCode: envelope.publicValidationCode,
        finalizing: !!envelope.finalizationRequestedAt && !completed,
      },
      signer: {
        name: signer.name,
        email: maskEmail(signer.email),
        role: signer.role,
        status: signer.status,
        authMethod: signer.authMethod,
        authMethodLabel: authMethodLabel(signer.authMethod),
        authenticated: !!session.authenticatedAt,
        requiresOtp: requiresChallenge(signer.authMethod),
        // Canais para o código; o padrão segue o canal do link aberto.
        otp: requiresChallenge(signer.authMethod)
          ? (() => {
              const channels = otpChannels(signer, isWhatsAppEnabled());
              return {
                channels,
                defaultChannel: defaultOtpChannel(channels, session.linkChannel),
                destinations: { EMAIL: maskEmail(signer.email), WHATSAPP: maskPhone(signer.phone) },
              };
            })()
          : null,
        canSign:
          !!session.authenticatedAt &&
          signer.status === SignerStatus.AUTHENTICATED &&
          SIGNABLE_ENVELOPE_STATUSES.includes(envelope.status) &&
          !envelope.finalizationRequestedAt &&
          isSignersTurn(signers, signer.signingGroup),
        signedAt: signer.signedAt,
      },
      documents: docs.map((d) => ({
        id: d.id,
        filename: d.documentVersion.filename,
        pageCount: d.documentVersion.pageCount,
        sha256: d.originalSha256,
        finalAvailable: completed && !!d.finalStorageKey,
        finalSha256: completed ? d.finalSha256 : null,
        // Onde ESTE signatário vai assinar (destacado na visualização).
        fields: myFields
          .filter((f) => f.envelopeDocumentId === d.id)
          .map((f) => ({ type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height })),
      })),
      consent: { version: consent.version, text: consent.content },
    };
  }

  private assertAuthenticated(r: ResolvedSession): void {
    if (!r.session.authenticatedAt) throw Errors.unprocessable('AUTHENTICATION_REQUIRED', 'Autentique-se para continuar.');
  }

  /** VIEW (visualizador) e DOWNLOAD são registrados de forma distinta. */
  async openDocument(r: ResolvedSession, envelopeDocumentId: string, mode: 'view' | 'download', client: ClientInfo): Promise<{ stream: Readable; filename: string }> {
    this.assertAuthenticated(r);
    const ed = await this.prisma.envelopeDocument.findFirst({
      where: { id: envelopeDocumentId, envelopeId: r.envelope.id },
      include: { documentVersion: { select: { storageKey: true, filename: true, documentId: true } } },
    });
    if (!ed) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Documento não encontrado.');
    const useFinal = r.envelope.status === EnvelopeStatus.COMPLETED && !!ed.finalStorageKey;
    const key = useFinal ? ed.finalStorageKey! : ed.documentVersion.storageKey;
    const { stream } = await this.storage.getStream(key);

    const base = {
      actor: { type: ActorType.SIGNER, id: r.signer.id },
      organizationId: r.envelope.organizationId,
      envelopeId: r.envelope.id,
      signerId: r.signer.id,
      documentId: ed.documentVersion.documentId,
      ...client,
    };
    if (mode === 'download') {
      await this.audit.recordStandalone({ ...base, eventType: AuditEventType.DOCUMENT_DOWNLOADED, metadata: { envelopeDocumentId: ed.id, kind: useFinal ? 'final' : 'original' } });
    } else if (!useFinal) {
      await this.recordFirstView(r, ed.id, ed.documentVersion.documentId, ed.originalSha256, client);
    }
    const filename = useFinal ? ed.documentVersion.filename.replace(/\.pdf$/i, '') + '-assinado.pdf' : ed.documentVersion.filename;
    return { stream, filename };
  }

  private async recordFirstView(r: ResolvedSession, envelopeDocumentId: string, documentId: string, sha256: string, client: ClientInfo): Promise<void> {
    const event = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "signers" WHERE "id" = ${r.signer.id}::uuid FOR UPDATE`;
      const seen = await tx.auditEvent.findFirst({
        where: { envelopeId: r.envelope.id, signerId: r.signer.id, documentId, eventType: AuditEventType.DOCUMENT_VIEWED },
        select: { id: true },
      });
      if (seen) return null;
      const now = new Date();
      await tx.signer.updateMany({
        where: { id: r.signer.id, status: { in: signerSourcesFor(SignerStatus.VIEWED) } },
        data: { status: SignerStatus.VIEWED },
      });
      await tx.signer.updateMany({ where: { id: r.signer.id, viewedAt: null }, data: { viewedAt: now } });
      await this.audit.record(tx, {
        eventType: AuditEventType.DOCUMENT_VIEWED,
        actor: { type: ActorType.SIGNER, id: r.signer.id },
        organizationId: r.envelope.organizationId,
        envelopeId: r.envelope.id,
        signerId: r.signer.id,
        documentId,
        ...client,
        occurredAt: now,
        metadata: { envelopeDocumentId, sha256 },
      });
      return this.outbox.emit(tx, {
        type: DomainEvent.DOCUMENT_VIEWED,
        organizationId: r.envelope.organizationId,
        payload: { envelopeId: r.envelope.id, signerId: r.signer.id, documentId },
        requestId: client.requestId,
      });
    });
    if (event) await this.outbox.dispatch(event);
  }

  async openEvidence(r: ResolvedSession, client: ClientInfo) {
    this.assertAuthenticated(r);
    if (r.envelope.status !== EnvelopeStatus.COMPLETED) throw Errors.notFound('EVIDENCE_NOT_AVAILABLE', 'Relatório ainda não disponível.');
    const report = await this.prisma.evidenceReport.findUnique({ where: { envelopeId: r.envelope.id } });
    if (!report) throw Errors.notFound('EVIDENCE_NOT_AVAILABLE', 'Relatório ainda não disponível.');
    const { stream } = await this.storage.getStream(report.storageKey);
    await this.audit.recordStandalone({
      eventType: AuditEventType.EVIDENCE_DOWNLOADED,
      actor: { type: ActorType.SIGNER, id: r.signer.id },
      organizationId: r.envelope.organizationId,
      envelopeId: r.envelope.id,
      signerId: r.signer.id,
      ...client,
      metadata: { sha256: report.sha256 },
    });
    return { stream, filename: `evidencias-${r.envelope.publicValidationCode}.pdf` };
  }

  async sign(r: ResolvedSession, input: Parameters<SignatureEngine['sign']>[1], client: ClientInfo) {
    this.assertAuthenticated(r);
    const result = await this.engine.sign({ signatureSessionId: r.session.id, signerId: r.signer.id, envelopeId: r.envelope.id, client }, input);
    return { signatureId: result.signatureId, signedAt: result.signedAt, replay: result.idempotentReplay };
  }

  /** Recusa: signatário obrigatório impede a conclusão normal (envelope → DECLINED). */
  async decline(r: ResolvedSession, reasonInput: string | undefined, client: ClientInfo): Promise<void> {
    this.assertAuthenticated(r);
    const reason = reasonInput ? cleanText(reasonInput, 500) : null;
    const events = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "envelopes" WHERE "id" = ${r.envelope.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "signers" WHERE "id" = ${r.signer.id}::uuid FOR UPDATE`;
      const envelope = await tx.envelope.findUniqueOrThrow({ where: { id: r.envelope.id } });
      const signer = await tx.signer.findUniqueOrThrow({ where: { id: r.signer.id } });
      if (!SIGNABLE_ENVELOPE_STATUSES.includes(envelope.status) || envelope.finalizationRequestedAt) {
        throw Errors.conflict('ENVELOPE_NOT_SIGNABLE', 'Este envelope não aceita mais ações.');
      }
      if (!signerSourcesFor(SignerStatus.DECLINED).includes(signer.status)) {
        throw Errors.conflict('SIGNER_CANNOT_DECLINE', 'Não é possível recusar neste momento.');
      }
      const now = new Date();
      await tx.signer.update({ where: { id: signer.id }, data: { status: SignerStatus.DECLINED, declinedAt: now, declineReason: reason } });
      const base = { organizationId: envelope.organizationId, envelopeId: envelope.id, ...client };
      await this.audit.record(tx, {
        ...base,
        eventType: AuditEventType.SIGNER_DECLINED,
        actor: { type: ActorType.SIGNER, id: signer.id },
        signerId: signer.id,
        occurredAt: now,
        metadata: { reason, required: signer.required },
      });
      const out: EmittedEvent[] = [
        await this.outbox.emit(tx, {
          type: DomainEvent.SIGNER_DECLINED,
          organizationId: envelope.organizationId,
          payload: { envelopeId: envelope.id, signerId: signer.id },
          requestId: client.requestId,
        }),
      ];
      if (signer.required) {
        await tx.envelope.update({ where: { id: envelope.id }, data: { status: EnvelopeStatus.DECLINED, declinedAt: now } });
        await this.envelopes.revokeSignerAccess(tx, envelope.id, now);
        await this.audit.record(tx, {
          ...base,
          eventType: AuditEventType.ENVELOPE_DECLINED,
          actor: { type: ActorType.SYSTEM },
          occurredAt: now,
          metadata: { declinedBySignerId: signer.id },
        });
      } else {
        out.push(...(await this.engine.evaluateProgress(tx, envelope, client)));
      }
      return out;
    });
    await this.outbox.dispatch(events);
  }

  async endSession(r: ResolvedSession): Promise<void> {
    await this.prisma.signatureSession.update({ where: { id: r.session.id }, data: { revokedAt: new Date() } });
  }
}
