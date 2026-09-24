import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Prisma, UsageMetric } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageKeys, StorageService } from '../../infra/storage/storage.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { sha256Hex } from '../../common/crypto/crypto.util';
import { Errors } from '../../common/errors/app-error';
import { hasPdfExtension, inspectPdf } from '../../common/util/pdf-validation';
import { cleanText } from '../../common/util/text';
import { paginated, resolvePagination, type PaginationQueryDto } from '../../common/util/pagination';
import type { ClientInfo } from '../../common/http/client-info';
import { actorOf, creatorFields, type AuthContext } from '../../common/auth/auth-context';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { LimitsService } from '../billing/limits.service';
import { UsageService } from '../billing/usage.service';

export interface UploadedPdf {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface DocumentListQuery extends PaginationQueryDto {
  search?: string;
  status?: 'ACTIVE' | 'LOCKED';
  createdById?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger('Documents');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly limits: LimitsService,
    private readonly usage: UsageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Validação completa do upload (seção 9/48). Nunca confia no Content-Type do navegador. */
  private async validate(file: UploadedPdf | undefined): Promise<{ pageCount: number; filename: string }> {
    if (!file || !file.buffer?.length) throw Errors.validation('Nenhum arquivo enviado.');
    const filename = cleanText(file.originalname || 'documento.pdf', 200);
    if (!hasPdfExtension(filename)) throw Errors.validation('Somente arquivos com extensão .pdf são aceitos.', { reason: 'extension' });
    if (file.mimetype !== 'application/pdf') throw Errors.validation('Tipo de arquivo não suportado.', { reason: 'mime' });
    if (file.size > this.config.UPLOAD_MAX_BYTES || file.buffer.length > this.config.UPLOAD_MAX_BYTES) {
      throw Errors.validation('Arquivo excede o tamanho máximo permitido.', { max_bytes: this.config.UPLOAD_MAX_BYTES });
    }
    // Ponto de integração futura com antivírus (ex.: ClamAV) antes de aceitar o arquivo.
    const { pageCount } = await inspectPdf(file.buffer); // magic bytes + estrutura
    return { pageCount, filename };
  }

  async upload(auth: AuthContext, file: UploadedPdf | undefined, titleInput: string | undefined, client: ClientInfo) {
    const { pageCount, filename } = await this.validate(file);
    const buffer = file!.buffer;
    const sha256 = sha256Hex(buffer);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const storageKey = StorageKeys.originalVersion(auth.organizationId, documentId, 1, versionId);
    const title = cleanText(titleInput?.trim() || filename.replace(/\.pdf$/i, ''), 200);

    // Pré-checagem de limites antes de enviar ao storage (a checagem definitiva é na transação).
    await this.prisma.tx((tx) => this.limits.assertCanUploadDocument(tx, auth.organizationId, buffer.length));
    await this.storage.putImmutable(storageKey, buffer, 'application/pdf', sha256);

    try {
      return await this.prisma.tx(async (tx) => {
        await this.limits.assertCanUploadDocument(tx, auth.organizationId, buffer.length);
        const doc = await tx.document.create({
          data: { id: documentId, organizationId: auth.organizationId, title, originalFilename: filename, ...creatorFields(auth) },
        });
        const version = await tx.documentVersion.create({
          data: {
            id: versionId,
            organizationId: auth.organizationId,
            documentId,
            versionNumber: 1,
            filename,
            mimeType: 'application/pdf',
            sizeBytes: BigInt(buffer.length),
            pageCount,
            storageKey,
            sha256,
            createdById: auth.kind === 'user' ? auth.userId : null,
          },
        });
        await this.usage.increment(tx, auth.organizationId, UsageMetric.DOCUMENTS_UPLOADED, 1);
        await this.usage.increment(tx, auth.organizationId, UsageMetric.STORAGE_BYTES, buffer.length);
        const base = { actor: actorOf(auth), organizationId: auth.organizationId, documentId, ...client };
        await this.audit.record(tx, { ...base, eventType: AuditEventType.DOCUMENT_CREATED, metadata: { title } });
        await this.audit.record(tx, {
          ...base,
          eventType: AuditEventType.DOCUMENT_UPLOADED,
          metadata: { versionId, versionNumber: 1, sha256, sizeBytes: buffer.length, pageCount, filename },
        });
        return this.serializeDocument({ ...doc, versions: [version] });
      });
    } catch (err) {
      await this.storage.deleteOrphan(storageKey).catch((e: unknown) =>
        this.logger.error({ event: 'orphan_cleanup_failed', storage_key: storageKey, error: (e as Error).message }),
      );
      throw err;
    }
  }

  /** Nova versão: novo arquivo, novo hash, novo ID. A versão anterior permanece intacta. */
  async addVersion(auth: AuthContext, documentId: string, file: UploadedPdf | undefined, client: ClientInfo) {
    const doc = await this.findOwned(auth, documentId);
    const { pageCount, filename } = await this.validate(file);
    const buffer = file!.buffer;
    const sha256 = sha256Hex(buffer);
    const versionId = randomUUID();
    const last = await this.prisma.documentVersion.findFirst({ where: { documentId: doc.id }, orderBy: { versionNumber: 'desc' } });
    const versionNumber = (last?.versionNumber ?? 0) + 1;
    const storageKey = StorageKeys.originalVersion(auth.organizationId, doc.id, versionNumber, versionId);

    await this.prisma.tx((tx) => this.limits.assertCanUploadDocument(tx, auth.organizationId, buffer.length));
    await this.storage.putImmutable(storageKey, buffer, 'application/pdf', sha256);
    try {
      return await this.prisma.tx(async (tx) => {
        await this.limits.assertCanUploadDocument(tx, auth.organizationId, buffer.length);
        const version = await tx.documentVersion.create({
          data: {
            id: versionId,
            organizationId: auth.organizationId,
            documentId: doc.id,
            versionNumber,
            filename,
            mimeType: 'application/pdf',
            sizeBytes: BigInt(buffer.length),
            pageCount,
            storageKey,
            sha256,
            createdById: auth.kind === 'user' ? auth.userId : null,
          },
        });
        await tx.document.update({ where: { id: doc.id }, data: { updatedAt: new Date() } });
        await this.usage.increment(tx, auth.organizationId, UsageMetric.STORAGE_BYTES, buffer.length);
        await this.audit.record(tx, {
          eventType: AuditEventType.DOCUMENT_VERSION_CREATED,
          actor: actorOf(auth),
          organizationId: auth.organizationId,
          documentId: doc.id,
          ...client,
          metadata: { versionId, versionNumber, sha256, sizeBytes: buffer.length, previousSha256: last?.sha256 ?? null },
        });
        return this.serializeVersion(version);
      });
    } catch (err) {
      await this.storage.deleteOrphan(storageKey).catch(() => undefined);
      throw err;
    }
  }

  async list(auth: AuthContext, q: DocumentListQuery) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const where: Prisma.DocumentWhereInput = {
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.createdById ? { createdById: q.createdById } : {}),
      ...(q.search
        ? {
            OR: [
              { title: { contains: q.search, mode: 'insensitive' } },
              { originalFilename: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          versions: {
            orderBy: { versionNumber: 'desc' },
            take: 1,
            include: { envelopeDocuments: { select: { envelopeId: true, envelope: { select: { id: true, title: true, status: true } } } } },
          },
        },
      }),
    ]);
    return paginated(
      rows.map((d) => ({
        ...this.serializeDocument(d),
        envelopes: d.versions[0]?.envelopeDocuments.map((ed) => ed.envelope) ?? [],
      })),
      total,
      page,
      pageSize,
    );
  }

  async get(auth: AuthContext, documentId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, organizationId: auth.organizationId, deletedAt: null },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          include: { envelopeDocuments: { select: { envelope: { select: { id: true, title: true, status: true } } } } },
        },
      },
    });
    if (!doc) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Documento não encontrado.');
    return {
      ...this.serializeDocument(doc),
      versions: doc.versions.map((v) => ({ ...this.serializeVersion(v), envelopes: v.envelopeDocuments.map((e) => e.envelope) })),
    };
  }

  async openVersion(
    auth: AuthContext,
    documentId: string,
    versionId: string,
    mode: 'view' | 'download',
    client: ClientInfo,
  ): Promise<{ stream: Readable; filename: string; size: bigint }> {
    const version = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId, organizationId: auth.organizationId, document: { deletedAt: null } },
    });
    if (!version) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Documento não encontrado.');
    const { stream } = await this.storage.getStream(version.storageKey);
    if (mode === 'download') {
      await this.audit.recordStandalone({
        eventType: AuditEventType.DOCUMENT_DOWNLOADED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        documentId,
        ...client,
        metadata: { versionId, kind: 'original' },
      });
    }
    return { stream, filename: version.filename, size: version.sizeBytes };
  }

  async softDelete(auth: AuthContext, documentId: string) {
    const doc = await this.findOwned(auth, documentId);
    const inUse = await this.prisma.envelopeDocument.count({
      where: { documentVersion: { documentId: doc.id }, envelope: { status: { not: 'DRAFT' } } },
    });
    if (inUse > 0) throw Errors.unprocessable('DOCUMENT_IN_USE', 'Documento vinculado a envelope enviado não pode ser removido.');
    await this.prisma.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
  }

  private async findOwned(auth: AuthContext, documentId: string) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, organizationId: auth.organizationId, deletedAt: null } });
    if (!doc) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Documento não encontrado.');
    return doc;
  }

  private serializeVersion(v: {
    id: string;
    versionNumber: number;
    filename: string;
    sizeBytes: bigint;
    pageCount: number;
    sha256: string;
    createdAt: Date;
  }) {
    return {
      id: v.id,
      versionNumber: v.versionNumber,
      filename: v.filename,
      sizeBytes: Number(v.sizeBytes),
      pageCount: v.pageCount,
      sha256: v.sha256,
      createdAt: v.createdAt,
    };
  }

  private serializeDocument(d: {
    id: string;
    title: string;
    originalFilename: string;
    status: string;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
    versions: Array<{ id: string; versionNumber: number; filename: string; sizeBytes: bigint; pageCount: number; sha256: string; createdAt: Date }>;
  }) {
    return {
      id: d.id,
      title: d.title,
      originalFilename: d.originalFilename,
      status: d.status,
      createdById: d.createdById,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      latestVersion: d.versions[0] ? this.serializeVersion(d.versions[0]) : null,
    };
  }
}
