import { Inject, Injectable } from '@nestjs/common';
import type { PageCorner, Prisma, SigningMode } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Errors } from '../../common/errors/app-error';
import { hasPdfExtension, inspectPdf } from '../../common/util/pdf-validation';
import { cleanText } from '../../common/util/text';
import type { ClientInfo } from '../../common/http/client-info';
import { actorOf, type AuthContext } from '../../common/auth/auth-context';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import type { UploadedPdf } from '../documents/documents.service';
import { planTemplateFields, scanPage, type ScannedDocument, type TemplatePlan } from './anchors';
import { extractPagesText, PdfTextError } from './pdf-text';
import type { UpsertTemplateDto } from './templates.dto';

/** Limite de páginas lidas na busca de âncoras (proteção contra PDFs abusivos). */
const MAX_SCAN_PAGES = 300;

const templateInclude = { roles: { orderBy: { position: 'asc' } } } satisfies Prisma.TemplateInclude;
export type TemplateWithRoles = Prisma.TemplateGetPayload<{ include: typeof templateInclude }>;

export interface TemplateRoleView {
  key: string;
  label: string;
  signingGroup: number;
  isCompany: boolean;
  initialsAllPages: boolean;
  initialsCorner: PageCorner;
}

/** O plano só pode ser aplicado sem pendências (âncora inválida, papel desconhecido ou sem assinatura). */
export function isPlanValid(plan: TemplatePlan<unknown>): boolean {
  return plan.missingSignature.length === 0 && plan.unknownRoles.length === 0 && plan.invalid.length === 0;
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  serialize(t: TemplateWithRoles) {
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      description: t.description,
      signingMode: t.signingMode as SigningMode,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      roles: t.roles.map(
        (r): TemplateRoleView => ({
          key: r.key,
          label: r.label,
          signingGroup: r.signingGroup,
          isCompany: r.isCompany,
          initialsAllPages: r.initialsAllPages,
          initialsCorner: r.initialsCorner,
        }),
      ),
    };
  }

  async list(auth: AuthContext) {
    const rows = await this.prisma.template.findMany({
      where: { organizationId: auth.organizationId, archivedAt: null },
      include: templateInclude,
      orderBy: { name: 'asc' },
    });
    return rows.map((t) => this.serialize(t));
  }

  /** Modelo ativo da organização (escopo de tenant explícito). */
  async findActive(auth: AuthContext, templateId: string): Promise<TemplateWithRoles> {
    const t = await this.prisma.template.findFirst({
      where: { id: templateId, organizationId: auth.organizationId, archivedAt: null },
      include: templateInclude,
    });
    if (!t) throw Errors.notFound('TEMPLATE_NOT_FOUND', 'Modelo não encontrado.');
    return t;
  }

  async get(auth: AuthContext, templateId: string) {
    return this.serialize(await this.findActive(auth, templateId));
  }

  async create(auth: AuthContext, dto: UpsertTemplateDto, client: ClientInfo) {
    const roles = this.normalizeRoles(dto);
    const created = await this.uniqueKey(() =>
      this.prisma.tx(async (tx) => {
        const t = await tx.template.create({
          data: {
            organizationId: auth.organizationId,
            key: dto.key,
            name: cleanText(dto.name, 120),
            description: dto.description ? cleanText(dto.description, 500) : null,
            signingMode: dto.signingMode ?? 'SEQUENTIAL',
            createdById: auth.kind === 'user' ? auth.userId : null,
            roles: { create: roles.map((r) => ({ ...r, organizationId: auth.organizationId })) },
          },
          include: templateInclude,
        });
        await this.audit.record(tx, {
          eventType: AuditEventType.TEMPLATE_CREATED,
          actor: actorOf(auth),
          organizationId: auth.organizationId,
          ...client,
          metadata: { templateId: t.id, key: t.key, roles: roles.map((r) => r.key) },
        });
        return t;
      }),
    );
    return this.serialize(created);
  }

  async update(auth: AuthContext, templateId: string, dto: UpsertTemplateDto, client: ClientInfo) {
    const roles = this.normalizeRoles(dto);
    const updated = await this.uniqueKey(() =>
      this.prisma.tx(async (tx) => {
        const current = await tx.template.findFirst({
          where: { id: templateId, organizationId: auth.organizationId, archivedAt: null },
          select: { id: true },
        });
        if (!current) throw Errors.notFound('TEMPLATE_NOT_FOUND', 'Modelo não encontrado.');
        await tx.templateRole.deleteMany({ where: { templateId } });
        const t = await tx.template.update({
          where: { id: templateId },
          data: {
            key: dto.key,
            name: cleanText(dto.name, 120),
            description: dto.description ? cleanText(dto.description, 500) : null,
            signingMode: dto.signingMode ?? 'SEQUENTIAL',
            roles: { create: roles.map((r) => ({ ...r, organizationId: auth.organizationId })) },
          },
          include: templateInclude,
        });
        await this.audit.record(tx, {
          eventType: AuditEventType.TEMPLATE_UPDATED,
          actor: actorOf(auth),
          organizationId: auth.organizationId,
          ...client,
          metadata: { templateId: t.id, key: t.key, roles: roles.map((r) => r.key) },
        });
        return t;
      }),
    );
    return this.serialize(updated);
  }

  /** Arquiva (soft delete) e libera a chave para um novo modelo. Envelopes já criados não são afetados. */
  async archive(auth: AuthContext, templateId: string, client: ClientInfo): Promise<void> {
    await this.prisma.tx(async (tx) => {
      const t = await tx.template.findFirst({
        where: { id: templateId, organizationId: auth.organizationId, archivedAt: null },
        select: { id: true, key: true },
      });
      if (!t) throw Errors.notFound('TEMPLATE_NOT_FOUND', 'Modelo não encontrado.');
      const archivedKey = `arq-${t.id.replace(/-/g, '').slice(-12)}-${t.key}`.slice(0, 60);
      await tx.template.update({ where: { id: t.id }, data: { archivedAt: new Date(), key: archivedKey } });
      await this.audit.record(tx, {
        eventType: AuditEventType.TEMPLATE_ARCHIVED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { templateId: t.id, key: t.key },
      });
    });
  }

  // ───────────── Âncoras ─────────────

  /** Lê o texto dos PDFs e localiza as âncoras de cada página. */
  async scanDocuments<Ref>(docs: Array<{ ref: Ref; pdf: Buffer }>): Promise<ScannedDocument<Ref>[]> {
    const out: ScannedDocument<Ref>[] = [];
    for (const d of docs) {
      let pages;
      try {
        pages = await extractPagesText(d.pdf, { maxPages: MAX_SCAN_PAGES });
      } catch (err) {
        if (err instanceof PdfTextError) throw Errors.validation(err.message, { reason: 'pdf_text' });
        throw err;
      }
      out.push({
        ref: d.ref,
        pages: pages.map((p) => ({ page: p.page, viewWidth: p.viewWidth, viewHeight: p.viewHeight, scan: scanPage(p) })),
      });
    }
    return out;
  }

  async findActiveByKey(auth: AuthContext, key: string): Promise<TemplateWithRoles> {
    const t = await this.prisma.template.findFirst({
      where: { key, organizationId: auth.organizationId, archivedAt: null },
      include: templateInclude,
    });
    if (!t) throw Errors.notFound('TEMPLATE_NOT_FOUND', 'Modelo não encontrado.');
    return t;
  }

  /** Validação do PDF recebido (antes de qualquer armazenamento). */
  async assertPdfUpload(file: UploadedPdf | undefined): Promise<Buffer> {
    if (!file || !file.buffer?.length) throw Errors.validation('Nenhum arquivo enviado.');
    if (!hasPdfExtension(file.originalname || '') || file.mimetype !== 'application/pdf') {
      throw Errors.validation('Somente arquivos PDF são aceitos.');
    }
    if (file.size > this.config.UPLOAD_MAX_BYTES || file.buffer.length > this.config.UPLOAD_MAX_BYTES) {
      throw Errors.validation('Arquivo excede o tamanho máximo permitido.', { max_bytes: this.config.UPLOAD_MAX_BYTES });
    }
    await inspectPdf(file.buffer);
    return file.buffer;
  }

  /** Localiza as âncoras de um único PDF e calcula os campos do modelo. */
  async planPdf(template: TemplateWithRoles, pdf: Buffer) {
    const [scanned] = await this.scanDocuments([{ ref: 0, pdf }]);
    return { scanned, plan: planTemplateFields(template.roles, [scanned]) };
  }

  /** Testa um PDF de exemplo contra o modelo, sem armazenar nada. */
  async test(auth: AuthContext, templateId: string, file: UploadedPdf | undefined) {
    const template = await this.findActive(auth, templateId);
    const { scanned, plan } = await this.planPdf(template, await this.assertPdfUpload(file));
    return {
      ok: isPlanValid(plan),
      pages: scanned.pages.map((p) => ({ page: p.page, width: p.viewWidth, height: p.viewHeight })),
      anchors: plan.anchors.map(({ ref: _ref, ...a }) => a),
      fields: plan.fields.map(({ ref: _ref, ...f }) => f),
      missingSignature: plan.missingSignature,
      unknownRoles: plan.unknownRoles,
      invalid: plan.invalid.map(({ ref: _ref, ...i }) => i),
    };
  }

  private normalizeRoles(dto: UpsertTemplateDto) {
    const keys = new Set<string>();
    return dto.roles.map((r, position) => {
      if (keys.has(r.key)) throw Errors.validation(`Papel repetido: ${r.key}.`);
      keys.add(r.key);
      return {
        key: r.key,
        label: cleanText(r.label, 60),
        position,
        signingGroup: dto.signingMode === 'PARALLEL' ? 1 : (r.signingGroup ?? 1),
        isCompany: r.isCompany ?? false,
        initialsAllPages: r.initialsAllPages ?? false,
        initialsCorner: r.initialsCorner ?? 'BOTTOM_RIGHT',
      };
    });
  }

  private async uniqueKey<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
        throw Errors.conflict('TEMPLATE_KEY_TAKEN', 'Já existe um modelo com esse identificador.');
      }
      throw err;
    }
  }
}
