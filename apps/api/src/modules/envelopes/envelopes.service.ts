import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import {
  AuthMethod,
  DocumentStatus,
  EnvelopeStatus,
  Prisma,
  SignerRole,
  SignerStatus,
  SigningMode,
  UsageMetric,
} from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { StorageService } from '../../infra/storage/storage.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { Errors } from '../../common/errors/app-error';
import { maskCpf, maskEmail } from '../../common/util/mask';
import { cleanText, normalizeCpf, normalizeEmail } from '../../common/util/text';
import { generateValidationCode } from '../../common/util/validation-code';
import { paginated, resolvePagination } from '../../common/util/pagination';
import type { ClientInfo } from '../../common/http/client-info';
import { actorOf, creatorFields, type AuthContext } from '../../common/auth/auth-context';
import { AuditService } from '../audit/audit.service';
import { AuditEventLabels, AuditEventType, type AuditEventTypeValue } from '../audit/audit-events';
import { OutboxService, type EmittedEvent } from '../outbox/outbox.service';
import { DomainEvent } from '../outbox/domain-events';
import { LimitsService } from '../billing/limits.service';
import { UsageService } from '../billing/usage.service';
import { assertAuthMethodAvailable, authMethodLabel } from '../signing/auth-methods';
import { TemplatesService, isPlanValid } from '../templates/templates.service';
import { planTemplateFields } from '../templates/anchors';
import type { ApplyTemplateDto } from '../templates/templates.dto';
import { assertEnvelopeTransition, nextSigningGroup, signersToInvite, SIGNABLE_ENVELOPE_STATUSES } from './envelope-state';
import type {
  CreateEnvelopeDto,
  EnvelopeDocumentInputDto,
  ListEnvelopesQuery,
  SignerInputDto,
  UpdateEnvelopeDto,
  SetFieldsDto,
  FieldInputDto,
} from './envelopes.dto';

export function serializeField(f: {
  id: string;
  envelopeDocumentId: string;
  signerId: string;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return { id: f.id, envelopeDocumentId: f.envelopeDocumentId, signerId: f.signerId, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height };
}

const MAX_DOCUMENTS = 20;
const MAX_SIGNERS = 50;
const MAX_FIELDS = 200;

@Injectable()
export class EnvelopesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly limits: LimitsService,
    private readonly usage: UsageService,
    private readonly templates: TemplatesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ───────────── Consulta com escopo de tenant ─────────────

  /** Busca com lock (FOR UPDATE) e validação explícita de tenant. */
  private async lockEnvelope(tx: Tx, auth: AuthContext, envelopeId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "envelopes" WHERE "id" = ${envelopeId}::uuid AND "organization_id" = ${auth.organizationId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw Errors.notFound('ENVELOPE_NOT_FOUND', 'Envelope não encontrado.');
    return tx.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
  }

  private assertDraft(status: EnvelopeStatus): void {
    if (status !== EnvelopeStatus.DRAFT) {
      throw Errors.conflict('ENVELOPE_NOT_EDITABLE', 'Somente envelopes em rascunho podem ser alterados.');
    }
  }

  // ───────────── Criação / edição (rascunho) ─────────────

  async create(auth: AuthContext, dto: CreateEnvelopeDto, client: ClientInfo) {
    const expiresAt = this.parseExpiry(dto.expiresAt);
    const events: EmittedEvent[] = [];
    const id = await this.prisma.tx(async (tx) => {
      await this.limits.assertCanCreateEnvelope(tx, auth.organizationId);
      const envelope = await this.createWithUniqueCode(tx, {
        organizationId: auth.organizationId,
        title: cleanText(dto.title),
        message: dto.message ? cleanText(dto.message, 2000) : null,
        signingMode: dto.signingMode ?? SigningMode.PARALLEL,
        expiresAt,
        reminderIntervalHours: dto.reminderIntervalHours ?? null,
        ...creatorFields(auth),
      });
      await this.usage.increment(tx, auth.organizationId, UsageMetric.ENVELOPES_CREATED, 1);
      await this.audit.record(tx, {
        eventType: AuditEventType.ENVELOPE_CREATED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        envelopeId: envelope.id,
        ...client,
        metadata: { title: envelope.title, signingMode: envelope.signingMode, expiresAt: envelope.expiresAt },
      });
      for (const d of dto.documents ?? []) await this.addDocumentTx(tx, auth, envelope.id, d, client);
      for (const s of dto.signers ?? []) await this.addSignerTx(tx, auth, envelope.id, s, client);
      events.push(
        await this.outbox.emit(tx, {
          type: DomainEvent.ENVELOPE_CREATED,
          organizationId: auth.organizationId,
          payload: { envelopeId: envelope.id },
          requestId: client.requestId,
        }),
      );
      return envelope.id;
    });
    await this.outbox.dispatch(events);
    return this.get(auth, id);
  }

  private async createWithUniqueCode(tx: Tx, data: Omit<Prisma.EnvelopeUncheckedCreateInput, 'publicValidationCode'>) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateValidationCode(this.config.VALIDATION_CODE_PREFIX);
      const clash = await tx.envelope.findUnique({ where: { publicValidationCode: code }, select: { id: true } });
      if (!clash) return tx.envelope.create({ data: { ...data, publicValidationCode: code } });
    }
    throw new Error('Não foi possível gerar código de validação único');
  }

  private parseExpiry(value: string | null | undefined): Date | null {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now() + 60_000) {
      throw Errors.validation('A data de expiração deve estar no futuro.');
    }
    return d;
  }

  async update(auth: AuthContext, envelopeId: string, dto: UpdateEnvelopeDto, client: ClientInfo) {
    await this.prisma.tx(async (tx) => {
      const env = await this.lockEnvelope(tx, auth, envelopeId);
      this.assertDraft(env.status);
      const data: Prisma.EnvelopeUpdateInput = {};
      if (dto.title !== undefined) data.title = cleanText(dto.title);
      if (dto.message !== undefined) data.message = dto.message ? cleanText(dto.message, 2000) : null;
      if (dto.expiresAt !== undefined) data.expiresAt = this.parseExpiry(dto.expiresAt);
      if (dto.reminderIntervalHours !== undefined) data.reminderIntervalHours = dto.reminderIntervalHours;
      if (dto.signingMode !== undefined) {
        data.signingMode = dto.signingMode;
        if (dto.signingMode === SigningMode.PARALLEL) {
          await tx.signer.updateMany({ where: { envelopeId }, data: { signingGroup: 1 } });
        }
      }
      await tx.envelope.update({ where: { id: envelopeId }, data });
      await this.audit.record(tx, {
        eventType: AuditEventType.ENVELOPE_UPDATED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        envelopeId,
        ...client,
        metadata: { fields: Object.keys(data) },
      });
    });
    return this.get(auth, envelopeId);
  }

  async addDocument(auth: AuthContext, envelopeId: string, input: EnvelopeDocumentInputDto, client: ClientInfo) {
    await this.prisma.tx(async (tx) => {
      const env = await this.lockEnvelope(tx, auth, envelopeId);
      this.assertDraft(env.status);
      await this.addDocumentTx(tx, auth, envelopeId, input, client);
    });
    return this.get(auth, envelopeId);
  }

  private async addDocumentTx(tx: Tx, auth: AuthContext, envelopeId: string, input: EnvelopeDocumentInputDto, client: ClientInfo) {
    const version = await tx.documentVersion.findFirst({
      where: {
        organizationId: auth.organizationId,
        documentId: input.documentId,
        document: { deletedAt: null },
        ...(input.versionId ? { id: input.versionId } : {}),
      },
      orderBy: { versionNumber: 'desc' },
    });
    if (!version) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Documento não encontrado.');
    const count = await tx.envelopeDocument.count({ where: { envelopeId } });
    if (count >= MAX_DOCUMENTS) throw Errors.unprocessable('TOO_MANY_DOCUMENTS', `Máximo de ${MAX_DOCUMENTS} documentos por envelope.`);
    const dup = await tx.envelopeDocument.findFirst({ where: { envelopeId, documentVersion: { documentId: input.documentId } } });
    if (dup) throw Errors.conflict('DOCUMENT_ALREADY_IN_ENVELOPE', 'Documento já incluído neste envelope.');
    const last = await tx.envelopeDocument.findFirst({ where: { envelopeId }, orderBy: { position: 'desc' }, select: { position: true } });
    const ed = await tx.envelopeDocument.create({
      data: {
        organizationId: auth.organizationId,
        envelopeId,
        documentVersionId: version.id,
        position: (last?.position ?? 0) + 1,
        originalSha256: version.sha256,
      },
    });
    await this.audit.record(tx, {
      eventType: AuditEventType.ENVELOPE_DOCUMENT_ADDED,
      actor: actorOf(auth),
      organizationId: auth.organizationId,
      envelopeId,
      documentId: version.documentId,
      ...client,
      metadata: { envelopeDocumentId: ed.id, versionId: version.id, sha256: version.sha256, filename: version.filename },
    });
  }

  async removeDocument(auth: AuthContext, envelopeId: string, envelopeDocumentId: string, client: ClientInfo) {
    await this.prisma.tx(async (tx) => {
      const env = await this.lockEnvelope(tx, auth, envelopeId);
      this.assertDraft(env.status);
      const ed = await tx.envelopeDocument.findFirst({
        where: { id: envelopeDocumentId, envelopeId, organizationId: auth.organizationId },
        include: { documentVersion: { select: { documentId: true } } },
      });
      if (!ed) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Documento não encontrado no envelope.');
      await tx.envelopeDocument.delete({ where: { id: ed.id } });
      await this.audit.record(tx, {
        eventType: AuditEventType.ENVELOPE_DOCUMENT_REMOVED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        envelopeId,
        documentId: ed.documentVersion.documentId,
        ...client,
        metadata: { envelopeDocumentId },
      });
    });
    return this.get(auth, envelopeId);
  }

  async addSigner(auth: AuthContext, envelopeId: string, input: SignerInputDto, client: ClientInfo) {
    await this.prisma.tx(async (tx) => {
      const env = await this.lockEnvelope(tx, auth, envelopeId);
      this.assertDraft(env.status);
      await this.addSignerTx(tx, auth, envelopeId, input, client);
    });
    return this.get(auth, envelopeId);
  }

  private async addSignerTx(tx: Tx, auth: AuthContext, envelopeId: string, input: SignerInputDto, client: ClientInfo) {
    const env = await tx.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { signingMode: true } });
    const authMethod = input.authMethod ?? AuthMethod.EMAIL_OTP;
    assertAuthMethodAvailable(authMethod);
    const count = await tx.signer.count({ where: { envelopeId } });
    if (count >= MAX_SIGNERS) throw Errors.unprocessable('TOO_MANY_SIGNERS', `Máximo de ${MAX_SIGNERS} signatários por envelope.`);
    const email = normalizeEmail(input.email);
    let cpfEncrypted: string | null = null;
    let cpfLast2: string | null = null;
    if (input.cpf) {
      const cpf = normalizeCpf(input.cpf);
      if (!cpf) throw Errors.validation('CPF inválido.');
      cpfEncrypted = this.encryption.encrypt(cpf);
      cpfLast2 = cpf.slice(-2);
    }
    let signingGroup = 1;
    if (env.signingMode === SigningMode.SEQUENTIAL) {
      if (input.signingGroup) signingGroup = input.signingGroup;
      else {
        const max = await tx.signer.aggregate({ where: { envelopeId }, _max: { signingGroup: true } });
        signingGroup = (max._max.signingGroup ?? 0) + 1;
      }
    }
    const exists = await tx.signer.findUnique({ where: { envelopeId_email: { envelopeId, email } }, select: { id: true } });
    if (exists) throw Errors.conflict('SIGNER_ALREADY_EXISTS', 'Já existe um signatário com este e-mail no envelope.');
    const signer = await tx.signer.create({
      data: {
        organizationId: auth.organizationId,
        envelopeId,
        name: cleanText(input.name, 120),
        email,
        phone: input.phone ?? null,
        cpfEncrypted,
        cpfLast2,
        role: input.role ?? SignerRole.SIGNER,
        signingGroup,
        authMethod,
        required: input.required ?? true,
      },
    });
    await this.audit.record(tx, {
      eventType: AuditEventType.SIGNER_ADDED,
      actor: actorOf(auth),
      organizationId: auth.organizationId,
      envelopeId,
      signerId: signer.id,
      ...client,
      metadata: { email: maskEmail(email), role: signer.role, signingGroup, authMethod, required: signer.required },
    });
  }

  async removeSigner(auth: AuthContext, envelopeId: string, signerId: string, client: ClientInfo) {
    await this.prisma.tx(async (tx) => {
      const env = await this.lockEnvelope(tx, auth, envelopeId);
      this.assertDraft(env.status);
      const signer = await tx.signer.findFirst({ where: { id: signerId, envelopeId, organizationId: auth.organizationId } });
      if (!signer) throw Errors.notFound('SIGNER_NOT_FOUND', 'Signatário não encontrado.');
      await tx.signer.delete({ where: { id: signer.id } });
      await this.audit.record(tx, {
        eventType: AuditEventType.SIGNER_REMOVED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        envelopeId,
        signerId,
        ...client,
        metadata: { email: maskEmail(signer.email) },
      });
    });
    return this.get(auth, envelopeId);
  }

  // ───────────── Campos posicionados (rascunho) ─────────────

  async listFields(auth: AuthContext, envelopeId: string) {
    const env = await this.prisma.envelope.findFirst({ where: { id: envelopeId, organizationId: auth.organizationId }, select: { id: true } });
    if (!env) throw Errors.notFound('ENVELOPE_NOT_FOUND', 'Envelope não encontrado.');
    const rows = await this.prisma.envelopeField.findMany({
      where: { envelopeId, organizationId: auth.organizationId },
      orderBy: [{ page: 'asc' }, { y: 'asc' }],
    });
    return rows.map(serializeField);
  }

  /** Substitui todos os campos do rascunho (operação atômica). */
  async setFields(auth: AuthContext, envelopeId: string, dto: SetFieldsDto, client: ClientInfo) {
    await this.prisma.tx((tx) => this.replaceFieldsTx(tx, auth, envelopeId, dto.fields, client, { source: 'manual' }));
    return this.listFields(auth, envelopeId);
  }

  /**
   * Posiciona os campos a partir das âncoras dos PDFs do rascunho, conforme o modelo.
   * Recusa (sem alterar nada) se faltar assinatura de algum papel ou houver âncora inválida.
   */
  async applyTemplate(auth: AuthContext, envelopeId: string, dto: ApplyTemplateDto, client: ClientInfo) {
    const env = await this.prisma.envelope.findFirst({
      where: { id: envelopeId, organizationId: auth.organizationId },
      include: {
        documents: { orderBy: { position: 'asc' }, include: { documentVersion: { select: { storageKey: true } } } },
        signers: { select: { id: true } },
      },
    });
    if (!env) throw Errors.notFound('ENVELOPE_NOT_FOUND', 'Envelope não encontrado.');
    this.assertDraft(env.status);
    if (env.documents.length === 0) throw Errors.validation('Inclua ao menos um documento antes de aplicar o modelo.');
    const template = await this.templates.findActive(auth, dto.templateId);

    const signerIds = new Set(env.signers.map((s) => s.id));
    const signerByRole = new Map<string, string>();
    for (const a of dto.roles) {
      if (signerByRole.has(a.roleKey)) throw Errors.validation(`Papel informado mais de uma vez: ${a.roleKey}.`);
      if (!signerIds.has(a.signerId)) throw Errors.validation('Signatário não pertence ao envelope.');
      signerByRole.set(a.roleKey, a.signerId);
    }
    const unassigned = template.roles.filter((r) => !signerByRole.has(r.key)).map((r) => r.key);
    const extra = [...signerByRole.keys()].filter((k) => !template.roles.some((r) => r.key === k));
    if (unassigned.length > 0 || extra.length > 0) {
      throw Errors.validation('Associe exatamente um signatário a cada papel do modelo.', { unassigned, unknown: extra });
    }

    const pdfs = await Promise.all(
      env.documents.map(async (d) => ({ ref: d.id, pdf: await this.storage.getBuffer(d.documentVersion.storageKey) })),
    );
    const plan = planTemplateFields(template.roles, await this.templates.scanDocuments(pdfs));
    if (!isPlanValid(plan)) {
      throw Errors.unprocessable('TEMPLATE_ANCHORS_MISMATCH', 'As âncoras dos documentos não conferem com o modelo.', {
        missing_signature: plan.missingSignature,
        unknown_roles: plan.unknownRoles,
        invalid: plan.invalid.map((i) => ({ text: i.text, page: i.page, envelope_document_id: i.ref })),
      });
    }
    if (plan.fields.length > MAX_FIELDS) throw Errors.validation(`O modelo geraria mais de ${MAX_FIELDS} campos.`);

    const fields = plan.fields.map((f) => ({
      envelopeDocumentId: f.ref,
      signerId: signerByRole.get(f.role) as string,
      type: f.type,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
    }));
    await this.prisma.tx((tx) =>
      this.replaceFieldsTx(tx, auth, envelopeId, fields, client, {
        source: 'template',
        templateId: template.id,
        templateKey: template.key,
        anchors: plan.anchors.length,
      }),
    );
    return { fields: await this.listFields(auth, envelopeId), anchors: plan.anchors.length };
  }

  private async replaceFieldsTx(
    tx: Tx,
    auth: AuthContext,
    envelopeId: string,
    fields: FieldInputDto[],
    client: ClientInfo,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const env = await this.lockEnvelope(tx, auth, envelopeId);
    this.assertDraft(env.status);
    const [docs, signers] = await Promise.all([
      tx.envelopeDocument.findMany({ where: { envelopeId }, include: { documentVersion: { select: { pageCount: true } } } }),
      tx.signer.findMany({ where: { envelopeId }, select: { id: true } }),
    ]);
    const pages = new Map(docs.map((d) => [d.id, d.documentVersion.pageCount]));
    const signerIds = new Set(signers.map((s) => s.id));
    for (const f of fields) {
      const pageCount = pages.get(f.envelopeDocumentId);
      if (pageCount === undefined) throw Errors.validation('Campo aponta para documento que não está no envelope.');
      if (!signerIds.has(f.signerId)) throw Errors.validation('Campo aponta para signatário que não está no envelope.');
      if (f.page > pageCount) throw Errors.validation(`Página ${f.page} não existe no documento (${pageCount} páginas).`);
      if (f.x + f.width > 1.000001 || f.y + f.height > 1.000001) throw Errors.validation('Campo ultrapassa os limites da página.');
    }
    await tx.envelopeField.deleteMany({ where: { envelopeId } });
    if (fields.length > 0) {
      await tx.envelopeField.createMany({
        data: fields.map((f) => ({
          organizationId: auth.organizationId,
          envelopeId,
          envelopeDocumentId: f.envelopeDocumentId,
          signerId: f.signerId,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        })),
      });
    }
    await this.audit.record(tx, {
      eventType: AuditEventType.ENVELOPE_FIELDS_UPDATED,
      actor: actorOf(auth),
      organizationId: auth.organizationId,
      envelopeId,
      ...client,
      metadata: { count: fields.length, ...metadata },
    });
  }

  // ───────────── Ativação ─────────────

  async activate(auth: AuthContext, envelopeId: string, client: ClientInfo) {
    if (auth.kind === 'user') {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { emailVerifiedAt: true } });
      if (!user.emailVerifiedAt) {
        throw Errors.unprocessable('EMAIL_NOT_VERIFIED', 'Confirme seu e-mail antes de enviar documentos para assinatura.');
      }
    }
    const events = await this.prisma.tx(async (tx) => {
      const env = await this.lockEnvelope(tx, auth, envelopeId);
      if (env.status === EnvelopeStatus.ACTIVE) return [] as EmittedEvent[]; // repetição idempotente
      assertEnvelopeTransition(env.status, EnvelopeStatus.ACTIVE);
      if (env.expiresAt && env.expiresAt <= new Date()) throw Errors.validation('A data de expiração já passou. Atualize o prazo.');
      const docs = await tx.envelopeDocument.findMany({ where: { envelopeId }, include: { documentVersion: true } });
      const signers = await tx.signer.findMany({ where: { envelopeId } });
      const fields = await tx.envelopeField.findMany({ where: { envelopeId }, orderBy: [{ page: 'asc' }, { y: 'asc' }] });
      if (docs.length === 0) throw Errors.unprocessable('ENVELOPE_WITHOUT_DOCUMENTS', 'Adicione ao menos um documento.');
      if (signers.length === 0) throw Errors.unprocessable('ENVELOPE_WITHOUT_SIGNERS', 'Adicione ao menos um signatário.');
      if (!signers.some((s) => s.required)) throw Errors.unprocessable('ENVELOPE_WITHOUT_REQUIRED_SIGNER', 'Ao menos um signatário deve ser obrigatório.');
      for (const s of signers) assertAuthMethodAvailable(s.authMethod);

      const now = new Date();
      await tx.envelope.update({ where: { id: envelopeId }, data: { status: EnvelopeStatus.ACTIVE, activatedAt: now } });
      // A partir daqui os documentos deste processo são imutáveis (versão travada + trigger no banco).
      await tx.document.updateMany({
        where: { id: { in: docs.map((d) => d.documentVersion.documentId) }, organizationId: auth.organizationId },
        data: { status: DocumentStatus.LOCKED },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.ENVELOPE_ACTIVATED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        envelopeId,
        ...client,
        occurredAt: now,
        metadata: {
          documents: docs.map((d) => ({ envelopeDocumentId: d.id, versionId: d.documentVersionId, sha256: d.originalSha256 })),
          signers: signers.map((s) => ({ signerId: s.id, role: s.role, signingGroup: s.signingGroup, authMethod: s.authMethod })),
          signingMode: env.signingMode,
          expiresAt: env.expiresAt,
          // Posição exata de cada campo (evidência de onde cada signatário assina).
          fields: fields.map((f) => ({
            envelopeDocumentId: f.envelopeDocumentId,
            signerId: f.signerId,
            type: f.type,
            page: f.page,
            box: [f.x, f.y, f.width, f.height],
          })),
        },
      });
      const toInvite = signersToInvite(signers, nextSigningGroup(signers));
      const out: EmittedEvent[] = [];
      out.push(
        await this.outbox.emit(tx, {
          type: DomainEvent.SIGNERS_INVITE_REQUESTED,
          organizationId: auth.organizationId,
          payload: { envelopeId, signerIds: toInvite, kind: 'invite' },
          requestId: client.requestId,
        }),
      );
      out.push(
        await this.outbox.emit(tx, {
          type: DomainEvent.ENVELOPE_ACTIVATED,
          organizationId: auth.organizationId,
          payload: { envelopeId },
          requestId: client.requestId,
        }),
      );
      return out;
    });
    await this.outbox.dispatch(events);
    return this.get(auth, envelopeId);
  }

  // ───────────── Cancelamento ─────────────

  async cancel(auth: AuthContext, envelopeId: string, reason: string | undefined, client: ClientInfo) {
    const events = await this.prisma.tx(async (tx) => {
      const env = await this.lockEnvelope(tx, auth, envelopeId);
      if (env.status === EnvelopeStatus.CANCELLED) return [] as EmittedEvent[];
      assertEnvelopeTransition(env.status, EnvelopeStatus.CANCELLED);
      if (env.finalizationRequestedAt) {
        throw Errors.conflict('ENVELOPE_FINALIZING', 'Todas as assinaturas foram concluídas; o envelope está sendo finalizado.');
      }
      const now = new Date();
      await tx.envelope.update({
        where: { id: envelopeId },
        data: {
          status: EnvelopeStatus.CANCELLED,
          cancelledAt: now,
          cancelledById: auth.kind === 'user' ? auth.userId : null,
          cancelReason: reason ? cleanText(reason, 500) : null,
        },
      });
      await this.revokeSignerAccess(tx, envelopeId, now);
      await this.audit.record(tx, {
        eventType: AuditEventType.ENVELOPE_CANCELLED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        envelopeId,
        ...client,
        occurredAt: now,
        metadata: { reason: reason ? cleanText(reason, 500) : null, previousStatus: env.status },
      });
      if (env.status === EnvelopeStatus.DRAFT) return [] as EmittedEvent[];
      return [
        await this.outbox.emit(tx, {
          type: DomainEvent.ENVELOPE_CANCELLED,
          organizationId: auth.organizationId,
          payload: { envelopeId },
          requestId: client.requestId,
        }),
      ];
    });
    await this.outbox.dispatch(events);
    return this.get(auth, envelopeId);
  }

  /** Revoga links e sessões de assinatura (cancelamento/expiração). Nunca apaga histórico. */
  async revokeSignerAccess(tx: Tx, envelopeId: string, at: Date): Promise<void> {
    const signerIds = (await tx.signer.findMany({ where: { envelopeId }, select: { id: true } })).map((s) => s.id);
    await tx.signerAccessToken.updateMany({ where: { signerId: { in: signerIds }, revokedAt: null }, data: { revokedAt: at } });
    await tx.signatureSession.updateMany({ where: { envelopeId, revokedAt: null }, data: { revokedAt: at } });
  }

  // ───────────── Lembrete manual ─────────────

  async remind(auth: AuthContext, envelopeId: string, signerId: string | undefined, client: ClientInfo) {
    const event = await this.prisma.tx(async (tx) => {
      const env = await this.lockEnvelope(tx, auth, envelopeId);
      if (!SIGNABLE_ENVELOPE_STATUSES.includes(env.status) || env.finalizationRequestedAt) {
        throw Errors.conflict('ENVELOPE_NOT_ACTIVE', 'Envelope não está aguardando assinaturas.');
      }
      const minGap = new Date(Date.now() - 3600 * 1000);
      const targets = await tx.signer.findMany({
        where: {
          envelopeId,
          ...(signerId ? { id: signerId } : {}),
          status: { in: [SignerStatus.INVITED, SignerStatus.VIEWED, SignerStatus.AUTHENTICATED] },
          OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: minGap } }],
        },
        select: { id: true },
      });
      if (targets.length === 0) {
        throw Errors.unprocessable('NO_SIGNERS_TO_REMIND', 'Nenhum signatário pendente elegível (limite: 1 lembrete por hora).');
      }
      return this.outbox.emit(tx, {
        type: DomainEvent.SIGNERS_INVITE_REQUESTED,
        organizationId: auth.organizationId,
        payload: { envelopeId, signerIds: targets.map((t) => t.id), kind: 'reminder' },
        requestId: client.requestId,
      });
    });
    await this.outbox.dispatch(event);
    return { ok: true };
  }

  // ───────────── Consulta ─────────────

  async list(auth: AuthContext, q: ListEnvelopesQuery) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const search = q.search?.trim();
    const where: Prisma.EnvelopeWhereInput = {
      organizationId: auth.organizationId,
      ...(q.status ? { status: q.status } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { publicValidationCode: { equals: search.toUpperCase() } },
              { signers: { some: { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search.toLowerCase() } }] } } },
              { documents: { some: { documentVersion: { document: { title: { contains: search, mode: 'insensitive' } } } } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.envelope.count({ where }),
      this.prisma.envelope.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          title: true,
          status: true,
          publicValidationCode: true,
          createdAt: true,
          activatedAt: true,
          completedAt: true,
          expiresAt: true,
          _count: { select: { documents: true } },
          signers: { select: { status: true } },
        },
      }),
    ]);
    return paginated(
      rows.map((e) => ({
        id: e.id,
        title: e.title,
        status: e.status,
        validationCode: e.status === EnvelopeStatus.DRAFT ? null : e.publicValidationCode,
        createdAt: e.createdAt,
        activatedAt: e.activatedAt,
        completedAt: e.completedAt,
        expiresAt: e.expiresAt,
        documentCount: e._count.documents,
        signerCount: e.signers.length,
        signedCount: e.signers.filter((s) => s.status === SignerStatus.SIGNED).length,
      })),
      total,
      page,
      pageSize,
    );
  }

  async get(auth: AuthContext, envelopeId: string) {
    const env = await this.prisma.envelope.findFirst({
      where: { id: envelopeId, organizationId: auth.organizationId },
      include: {
        documents: { orderBy: { position: 'asc' }, include: { documentVersion: true } },
        signers: { orderBy: [{ signingGroup: 'asc' }, { createdAt: 'asc' }], include: { signature: { select: { method: true, signedAt: true, authMethod: true } } } },
        evidenceReport: { select: { sha256: true, generatedAt: true, status: true } },
        fields: { orderBy: [{ page: 'asc' }, { y: 'asc' }] },
      },
    });
    if (!env) throw Errors.notFound('ENVELOPE_NOT_FOUND', 'Envelope não encontrado.');
    return {
      id: env.id,
      title: env.title,
      message: env.message,
      status: env.status,
      signingMode: env.signingMode,
      validationCode: env.status === EnvelopeStatus.DRAFT ? null : env.publicValidationCode,
      expiresAt: env.expiresAt,
      reminderIntervalHours: env.reminderIntervalHours,
      createdAt: env.createdAt,
      activatedAt: env.activatedAt,
      completedAt: env.completedAt,
      cancelledAt: env.cancelledAt,
      cancelReason: env.cancelReason,
      expiredAt: env.expiredAt,
      declinedAt: env.declinedAt,
      finalizing: !!env.finalizationRequestedAt && env.status !== EnvelopeStatus.COMPLETED,
      documents: env.documents.map((d) => ({
        id: d.id,
        position: d.position,
        documentId: d.documentVersion.documentId,
        versionId: d.documentVersionId,
        filename: d.documentVersion.filename,
        pageCount: d.documentVersion.pageCount,
        sizeBytes: Number(d.documentVersion.sizeBytes),
        originalSha256: d.originalSha256,
        finalSha256: d.finalSha256,
        finalAvailable: !!d.finalStorageKey,
      })),
      signers: env.signers.map((s) => ({
        id: s.id,
        name: s.name,
        email: s.email,
        phone: s.phone,
        cpf: maskCpf(s.cpfLast2),
        role: s.role,
        signingGroup: s.signingGroup,
        status: s.status,
        required: s.required,
        authMethod: s.authMethod,
        authMethodLabel: authMethodLabel(s.authMethod),
        invitedAt: s.invitedAt,
        viewedAt: s.viewedAt,
        authenticatedAt: s.authenticatedAt,
        signedAt: s.signedAt,
        declinedAt: s.declinedAt,
        declineReason: s.declineReason,
        signatureMethod: s.signature?.method ?? null,
      })),
      fields: env.fields.map(serializeField),
      evidenceReport: env.evidenceReport
        ? { sha256: env.evidenceReport.sha256, generatedAt: env.evidenceReport.generatedAt, status: env.evidenceReport.status }
        : null,
    };
  }

  async timeline(auth: AuthContext, envelopeId: string) {
    const env = await this.prisma.envelope.findFirst({ where: { id: envelopeId, organizationId: auth.organizationId }, select: { id: true } });
    if (!env) throw Errors.notFound('ENVELOPE_NOT_FOUND', 'Envelope não encontrado.');
    const [events, signers] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: { envelopeId, organizationId: auth.organizationId },
        orderBy: { sequence: 'asc' },
        select: { id: true, sequence: true, eventType: true, occurredAt: true, actorType: true, signerId: true, ip: true, eventHash: true },
      }),
      this.prisma.signer.findMany({ where: { envelopeId }, select: { id: true, name: true } }),
    ]);
    const names = new Map(signers.map((s) => [s.id, s.name]));
    const chain = await this.audit.verifyEnvelopeChain(envelopeId);
    return {
      chain: { valid: chain.valid, count: chain.count, headHash: chain.headHash, failure: chain.failure ?? null },
      events: events.map((e) => ({
        id: e.id,
        sequence: e.sequence,
        type: e.eventType,
        label: AuditEventLabels[e.eventType as AuditEventTypeValue] ?? e.eventType,
        occurredAt: e.occurredAt,
        actorType: e.actorType,
        signerName: e.signerId ? names.get(e.signerId) ?? null : null,
        ip: e.ip,
        eventHash: e.eventHash,
      })),
    };
  }

  // ───────────── Downloads (resultado) ─────────────

  async openFinalDocument(auth: AuthContext, envelopeId: string, envelopeDocumentId: string, client: ClientInfo) {
    const ed = await this.prisma.envelopeDocument.findFirst({
      where: { id: envelopeDocumentId, envelopeId, organizationId: auth.organizationId, envelope: { status: EnvelopeStatus.COMPLETED } },
      include: { documentVersion: { select: { filename: true, documentId: true } } },
    });
    if (!ed?.finalStorageKey) throw Errors.notFound('FINAL_DOCUMENT_NOT_AVAILABLE', 'Documento final ainda não disponível.');
    const { stream } = await this.storage.getStream(ed.finalStorageKey);
    await this.audit.recordStandalone({
      eventType: AuditEventType.DOCUMENT_DOWNLOADED,
      actor: actorOf(auth),
      organizationId: auth.organizationId,
      envelopeId,
      documentId: ed.documentVersion.documentId,
      ...client,
      metadata: { kind: 'final', envelopeDocumentId, sha256: ed.finalSha256 },
    });
    return { stream: stream as Readable, filename: ed.documentVersion.filename.replace(/\.pdf$/i, '') + '-assinado.pdf' };
  }

  async openEvidenceReport(auth: AuthContext, envelopeId: string, client: ClientInfo) {
    const report = await this.prisma.evidenceReport.findFirst({
      where: { envelopeId, organizationId: auth.organizationId, status: 'GENERATED' },
      include: { envelope: { select: { publicValidationCode: true } } },
    });
    if (!report) throw Errors.notFound('EVIDENCE_NOT_AVAILABLE', 'Relatório de evidências ainda não disponível.');
    const { stream } = await this.storage.getStream(report.storageKey);
    await this.audit.recordStandalone({
      eventType: AuditEventType.EVIDENCE_DOWNLOADED,
      actor: actorOf(auth),
      organizationId: auth.organizationId,
      envelopeId,
      ...client,
      metadata: { sha256: report.sha256 },
    });
    return { stream, filename: `evidencias-${report.envelope.publicValidationCode}.pdf` };
  }
}
