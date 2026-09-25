import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ActorType, EnvelopeStatus, SignerStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageKeys, StorageService } from '../../infra/storage/storage.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { BRANDING } from '../../config/config.module';
import type { Branding } from '../../config/branding';
import { sha256Hex } from '../../common/crypto/crypto.util';
import { maskCpf, maskEmail, maskIp } from '../../common/util/mask';
import { AuditService } from '../audit/audit.service';
import { AuditEventLabels, AuditEventType, type AuditEventTypeValue } from '../audit/audit-events';
import { verifyChain } from '../audit/audit-chain';
import { OutboxService } from '../outbox/outbox.service';
import { DomainEvent } from '../outbox/domain-events';
import { allRequiredSigned, SIGNABLE_ENVELOPE_STATUSES, TERMINAL_SIGNER_STATUSES } from '../envelopes/envelope-state';
import { authMethodLabel } from '../signing/auth-methods';
import { buildEvidenceReport } from './evidence-report.builder';
import { buildFinalDocument } from './final-document.builder';

export class FinalizationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalizationIntegrityError';
  }
}

const ACTOR_LABEL: Record<string, string> = {
  USER: 'Usuário',
  SIGNER: 'Signatário',
  API_KEY: 'Integração (API)',
  SYSTEM: 'Sistema',
  PLATFORM_ADMIN: 'Administração',
  PUBLIC: 'Público',
};

/**
 * Finalização atômica (seções 25 e 95). Só marca COMPLETED depois de:
 * validar documentos (hash recalculado), validar a trilha encadeada, gerar e armazenar
 * documentos finais + relatório de evidências. Idempotente e segura para retentativas.
 */
@Injectable()
export class FinalizationService {
  private readonly logger = new Logger('Finalization');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BRANDING) private readonly brand: Branding,
  ) {}

  async finalize(envelopeId: string, requestId: string | null = null): Promise<'completed' | 'skipped'> {
    const env = await this.prisma.envelope.findUnique({
      where: { id: envelopeId },
      include: {
        organization: { select: { name: true } },
        documents: { orderBy: { position: 'asc' }, include: { documentVersion: true } },
        fields: true,
        signers: { orderBy: [{ signingGroup: 'asc' }, { createdAt: 'asc' }], include: { signature: { include: { consent: { include: { legalTextVersion: true } } } } } },
      },
    });
    if (!env || env.status === EnvelopeStatus.COMPLETED) return 'skipped';
    if (!env.finalizationRequestedAt || !SIGNABLE_ENVELOPE_STATUSES.includes(env.status)) return 'skipped';
    if (!allRequiredSigned(env.signers)) throw new FinalizationIntegrityError('Nem todos os signatários obrigatórios assinaram');

    // 1-3. Valida documentos: recalcula hash do original armazenado.
    const originals = new Map<string, Buffer>();
    for (const d of env.documents) {
      const buf = await this.storage.getBuffer(d.documentVersion.storageKey);
      const actual = sha256Hex(buf);
      if (actual !== d.originalSha256 || actual !== d.documentVersion.sha256) {
        throw new FinalizationIntegrityError(`Hash divergente no documento ${d.id}: integridade não confirmada`);
      }
      originals.set(d.id, buf);
    }

    // 4. Valida evidências: assinaturas + trilha encadeada.
    const signed = env.signers.filter((s) => s.status === SignerStatus.SIGNED);
    for (const s of signed) {
      if (!s.signature || !s.signature.consent.accepted) throw new FinalizationIntegrityError(`Evidência ausente para signatário ${s.id}`);
    }
    const chainEvents = await this.audit.loadChain(`envelope:${env.id}`);
    const chain = verifyChain(chainEvents);
    if (!chain.valid) throw new FinalizationIntegrityError(`Trilha de auditoria inválida: ${JSON.stringify(chain.failure)}`);

    const completedAt = new Date();
    const attemptId = randomUUID();
    const uploaded: string[] = [];
    const tz = this.config.REPORT_TIMEZONE;

    try {
      // 5-7. Documentos finais (original preservado; final é novo objeto).
      const finals: Array<{ envelopeDocumentId: string; key: string; sha256: string; filename: string; pageCount: number; versionId: string; originalSha256: string }> = [];
      for (const d of env.documents) {
        const signerVisuals = await Promise.all(
          signed.map(async (s) => ({
            name: s.name,
            email: maskEmail(s.email),
            role: s.role,
            authentication: authMethodLabel(s.signature!.authMethod),
            signedAt: s.signature!.signedAt,
            method: s.signature!.method,
            typedName: s.signature!.typedName,
            image: s.signature!.assetStorageKey ? await this.loadAsset(s.signature!.assetStorageKey, s.signature!.assetSha256) : null,
            fields: env.fields
              .filter((f) => f.signerId === s.id && f.envelopeDocumentId === d.id)
              .map((f) => ({ type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height })),
          })),
        );
        const bytes = Buffer.from(
          await buildFinalDocument(originals.get(d.id)!, {
            brand: this.brand,
            timezone: tz,
            validationCode: env.publicValidationCode,
            envelopeTitle: env.title,
            filename: d.documentVersion.filename,
            originalSha256: d.originalSha256,
            signers: signerVisuals,
          }),
        );
        const sha256 = sha256Hex(bytes);
        const key = StorageKeys.final(env.organizationId, d.documentVersion.documentId, env.id, attemptId);
        await this.storage.putImmutable(key, bytes, 'application/pdf', sha256);
        uploaded.push(key);
        finals.push({
          envelopeDocumentId: d.id,
          key,
          sha256,
          filename: d.documentVersion.filename,
          pageCount: d.documentVersion.pageCount,
          versionId: d.documentVersionId,
          originalSha256: d.originalSha256,
        });
      }

      // 6. Relatório de evidências.
      const reportBytes = Buffer.from(
        await buildEvidenceReport({
          brand: this.brand,
          timezone: tz,
          envelope: {
            id: env.id,
            title: env.title,
            validationCode: env.publicValidationCode,
            organizationName: env.organization.name,
            createdAt: env.createdAt,
            activatedAt: env.activatedAt,
            completedAt,
            signingMode: env.signingMode,
          },
          documents: finals.map((f) => ({ filename: f.filename, pageCount: f.pageCount, versionId: f.versionId, originalSha256: f.originalSha256, finalSha256: f.sha256 })),
          signers: signed.map((s) => ({
            name: s.name,
            email: maskEmail(s.email),
            cpf: maskCpf(s.cpfLast2),
            role: s.role,
            authentication: authMethodLabel(s.signature!.authMethod),
            authenticatedAt: s.authenticatedAt,
            signedAt: s.signature!.signedAt,
            signatureMethod: s.signature!.method,
            ip: maskIp(s.signature!.ip),
            userAgent: s.signature!.userAgent,
            consentVersion: s.signature!.consent.legalTextVersion.version,
            consentSha256: s.signature!.consent.legalTextVersion.sha256,
            signatureId: s.signature!.id,
          })),
          events: chainEvents.map((e) => ({
            sequence: e.sequence,
            occurredAt: e.occurredAt,
            label: AuditEventLabels[e.eventType as AuditEventTypeValue] ?? e.eventType,
            actor: ACTOR_LABEL[e.actorType] ?? e.actorType,
            eventHash: e.eventHash,
          })),
          chain: { valid: chain.valid, count: chain.count, headHash: chain.headHash },
        }),
      );
      const reportSha = sha256Hex(reportBytes);
      const reportKey = StorageKeys.evidence(env.organizationId, env.id, attemptId);
      await this.storage.putImmutable(reportKey, reportBytes, 'application/pdf', reportSha);
      uploaded.push(reportKey);

      // 8-10. Persistência atômica + evento + webhook (via outbox).
      const event = await this.prisma.tx(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "envelopes" WHERE "id" = ${env.id}::uuid FOR UPDATE`;
        const current = await tx.envelope.findUniqueOrThrow({ where: { id: env.id } });
        if (current.status === EnvelopeStatus.COMPLETED) return null; // outra execução concluiu
        if (!SIGNABLE_ENVELOPE_STATUSES.includes(current.status) || !current.finalizationRequestedAt) {
          throw new FinalizationIntegrityError(`Envelope mudou de estado durante a finalização: ${current.status}`);
        }
        for (const f of finals) {
          await tx.envelopeDocument.update({ where: { id: f.envelopeDocumentId }, data: { finalStorageKey: f.key, finalSha256: f.sha256 } });
        }
        await tx.evidenceReport.create({
          data: {
            organizationId: env.organizationId,
            envelopeId: env.id,
            status: 'GENERATED',
            storageKey: reportKey,
            sha256: reportSha,
            chainHeadHash: chain.headHash,
            generatedAt: completedAt,
          },
        });
        // Signatários opcionais que não assinaram deixam de poder atuar.
        await tx.signer.updateMany({
          where: { envelopeId: env.id, status: { notIn: [...TERMINAL_SIGNER_STATUSES] } },
          data: { status: SignerStatus.EXPIRED },
        });
        await tx.envelope.update({ where: { id: env.id }, data: { status: EnvelopeStatus.COMPLETED, completedAt } });
        await this.audit.record(tx, {
          eventType: AuditEventType.ENVELOPE_COMPLETED,
          actor: { type: ActorType.SYSTEM },
          organizationId: env.organizationId,
          envelopeId: env.id,
          requestId,
          occurredAt: completedAt,
          metadata: {
            evidenceReportSha256: reportSha,
            chainHeadHashAtReport: chain.headHash,
            documents: finals.map((f) => ({ envelopeDocumentId: f.envelopeDocumentId, originalSha256: f.originalSha256, finalSha256: f.sha256 })),
          },
        });
        return this.outbox.emit(tx, {
          type: DomainEvent.ENVELOPE_COMPLETED,
          organizationId: env.organizationId,
          payload: { envelopeId: env.id },
          requestId,
        });
      });
      if (!event) {
        await this.cleanup(uploaded);
        return 'skipped';
      }
      await this.outbox.dispatch(event);
      this.logger.log({ event: 'envelope_completed', envelope_id: env.id, request_id: requestId });
      return 'completed';
    } catch (err) {
      await this.cleanup(uploaded);
      throw err;
    }
  }

  private async loadAsset(key: string, expectedSha: string | null): Promise<Buffer> {
    const buf = await this.storage.getBuffer(key);
    if (expectedSha && sha256Hex(buf) !== expectedSha) throw new FinalizationIntegrityError('Imagem de assinatura com hash divergente');
    return buf;
  }

  private async cleanup(keys: string[]): Promise<void> {
    for (const k of keys) {
      await this.storage.deleteOrphan(k).catch((e: unknown) => this.logger.error({ event: 'orphan_cleanup_failed', storage_key: k, error: (e as Error).message }));
    }
  }
}
