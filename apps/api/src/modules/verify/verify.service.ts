import { Injectable } from '@nestjs/common';
import { ActorType, EnvelopeStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageService } from '../../infra/storage/storage.service';
import { sha256Hex, sha256Stream } from '../../common/crypto/crypto.util';
import { Errors } from '../../common/errors/app-error';
import { maskEmail, maskName } from '../../common/util/mask';
import { isValidationCodeFormat, normalizeValidationCode } from '../../common/util/validation-code';
import { hasPdfMagic } from '../../common/util/pdf-validation';
import type { ClientInfo } from '../../common/http/client-info';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { authMethodLabel } from '../signing/auth-methods';

type Integrity = 'VERIFIED' | 'NOT_CONFIRMED';

/**
 * Validação pública (seções 28, 100, 101): recalcula hashes dos arquivos armazenados,
 * compara com os registros, valida a trilha e NUNCA oculta falhas. Exibe apenas o
 * mínimo necessário, com mascaramento.
 */
@Injectable()
export class VerifyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async byCode(input: string, client: ClientInfo) {
    const code = normalizeValidationCode(input);
    if (!isValidationCodeFormat(code)) throw Errors.validation('Código de validação em formato inválido.');
    const env = await this.prisma.envelope.findUnique({ where: { publicValidationCode: code }, select: { id: true, status: true } });
    if (!env || env.status === EnvelopeStatus.DRAFT) return { found: false as const };
    return this.report(env.id, client, { method: 'CODE' });
  }

  async byFile(buffer: Buffer | undefined, client: ClientInfo) {
    if (!buffer?.length) throw Errors.validation('Nenhum arquivo enviado.');
    if (!hasPdfMagic(buffer)) throw Errors.validation('O arquivo enviado não é um PDF.');
    const sha256 = sha256Hex(buffer);
    const [finals, originals, reports] = await Promise.all([
      this.prisma.envelopeDocument.findMany({ where: { finalSha256: sha256, envelope: { status: EnvelopeStatus.COMPLETED } }, select: { envelopeId: true }, take: 5 }),
      this.prisma.envelopeDocument.findMany({ where: { originalSha256: sha256, envelope: { status: EnvelopeStatus.COMPLETED } }, select: { envelopeId: true }, take: 5 }),
      this.prisma.evidenceReport.findMany({ where: { sha256 }, select: { envelopeId: true }, take: 5 }),
    ]);
    const matches: Array<{ envelopeId: string; matchType: 'FINAL_DOCUMENT' | 'ORIGINAL_DOCUMENT' | 'EVIDENCE_REPORT' }> = [
      ...finals.map((f) => ({ envelopeId: f.envelopeId, matchType: 'FINAL_DOCUMENT' as const })),
      ...originals.map((f) => ({ envelopeId: f.envelopeId, matchType: 'ORIGINAL_DOCUMENT' as const })),
      ...reports.map((f) => ({ envelopeId: f.envelopeId, matchType: 'EVIDENCE_REPORT' as const })),
    ];
    if (matches.length === 0) return { found: false as const, sha256 };
    const results = [];
    for (const m of matches.slice(0, 5)) {
      results.push({ matchType: m.matchType, ...(await this.report(m.envelopeId, client, { method: 'FILE', sha256, matchType: m.matchType })) });
    }
    return { found: true as const, sha256, results };
  }

  private async report(envelopeId: string, client: ClientInfo, context: Record<string, unknown>) {
    const env = await this.prisma.envelope.findUniqueOrThrow({
      where: { id: envelopeId },
      include: {
        organization: { select: { name: true } },
        documents: { orderBy: { position: 'asc' }, include: { documentVersion: { select: { filename: true, storageKey: true, sha256: true } } } },
        signers: { orderBy: [{ signingGroup: 'asc' }, { createdAt: 'asc' }], include: { signature: { select: { signedAt: true, authMethod: true } } } },
        evidenceReport: true,
      },
    });

    await this.audit.recordStandalone({
      eventType: AuditEventType.VALIDATION_PERFORMED,
      actor: { type: ActorType.PUBLIC },
      organizationId: env.organizationId,
      envelopeId: env.id,
      ...client,
      metadata: context,
    });

    const base = {
      found: true as const,
      envelope: {
        title: env.title,
        validationCode: env.publicValidationCode,
        status: env.status,
        organizationName: env.organization.name,
        activatedAt: env.activatedAt,
        completedAt: env.completedAt,
      },
    };
    if (env.status !== EnvelopeStatus.COMPLETED) {
      // Em andamento/cancelado/expirado: somente status, sem detalhes.
      return { ...base, integrity: null, documents: [], signers: [], evidence: null, chain: null };
    }

    const documents = [];
    let allOk = true;
    for (const d of env.documents) {
      const original = await this.rehash(d.documentVersion.storageKey);
      const final = d.finalStorageKey ? await this.rehash(d.finalStorageKey) : null;
      const ok = original === d.originalSha256 && original === d.documentVersion.sha256 && !!final && final === d.finalSha256;
      if (!ok) allOk = false;
      documents.push({ filename: d.documentVersion.filename, originalSha256: d.originalSha256, finalSha256: d.finalSha256, integrity: (ok ? 'VERIFIED' : 'NOT_CONFIRMED') as Integrity });
    }
    let evidence: { sha256: string; integrity: Integrity } | null = null;
    if (env.evidenceReport) {
      const actual = await this.rehash(env.evidenceReport.storageKey);
      const ok = actual === env.evidenceReport.sha256;
      if (!ok) allOk = false;
      evidence = { sha256: env.evidenceReport.sha256, integrity: ok ? 'VERIFIED' : 'NOT_CONFIRMED' };
    } else allOk = false;
    const chain = await this.audit.verifyEnvelopeChain(env.id);
    if (!chain.valid) allOk = false;

    return {
      ...base,
      integrity: (allOk ? 'VERIFIED' : 'NOT_CONFIRMED') as Integrity,
      documents,
      evidence,
      chain: { valid: chain.valid, events: chain.count },
      signers: env.signers
        .filter((s) => s.signature)
        .map((s) => ({
          name: maskName(s.name),
          email: maskEmail(s.email),
          role: s.role,
          authentication: authMethodLabel(s.signature!.authMethod),
          signedAt: s.signature!.signedAt,
        })),
    };
  }

  private async rehash(key: string): Promise<string | null> {
    try {
      const { stream } = await this.storage.getStream(key);
      return (await sha256Stream(stream)).sha256;
    } catch {
      return null;
    }
  }
}
