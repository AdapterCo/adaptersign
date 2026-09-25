import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type Redis from 'ioredis';
import { AuthMethod, EnvelopeStatus } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { REDIS } from '../../infra/redis/redis.provider';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { sha256Hex } from '../../common/crypto/crypto.util';
import { Errors } from '../../common/errors/app-error';
import type { ClientInfo } from '../../common/http/client-info';
import { actorOf, type AuthContext } from '../../common/auth/auth-context';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { DocumentsService, type UploadedPdf } from '../documents/documents.service';
import { EnvelopesService } from '../envelopes/envelopes.service';
import { isSignersTurn, SIGNABLE_ENVELOPE_STATUSES, TERMINAL_SIGNER_STATUSES } from '../envelopes/envelope-state';
import { SignatureEngine, type IntegrationSignContext } from '../signing/signature-engine';
import { issueSignerAccessToken } from '../signing/access-tokens';
import { TemplatesService, isPlanValid } from '../templates/templates.service';
import { CompanySignatureService } from './company-signature.service';
import { ContractDataDto } from './contracts.dto';

/** Envelopes com a mesma referência nestes estados não bloqueiam um novo envio. */
const CLOSED_STATUSES: EnvelopeStatus[] = [EnvelopeStatus.CANCELLED, EnvelopeStatus.EXPIRED, EnvelopeStatus.DECLINED];
const LOCK_TTL_MS = 120_000;

function flattenErrors(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    return [...Object.values(e.constraints ?? {}).map((m) => `${path}: ${m}`), ...flattenErrors(e.children ?? [], path)];
  });
}

/**
 * Contrato enviado por um sistema integrado, numa única chamada:
 * PDF (com âncoras) + modelo + referência externa + signatários por papel →
 * envelope ativo, assinatura da empresa registrada e link de assinatura do cliente.
 *
 * Idempotência natural pela referência externa: repetir o envio de um contrato já criado
 * (e não cancelado/expirado/recusado) retorna o mesmo envelope (replayed=true), retomando
 * etapas pendentes, sem duplicar documento nem envelope.
 */
@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
    private readonly documents: DocumentsService,
    private readonly envelopes: EnvelopesService,
    private readonly engine: SignatureEngine,
    private readonly companySignature: CompanySignatureService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async parseData(raw: unknown): Promise<ContractDataDto> {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 50_000) {
      throw Errors.validation('Envie os dados do contrato no campo "data" (JSON).');
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw Errors.validation('O campo "data" não é um JSON válido.');
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw Errors.validation('O campo "data" deve ser um objeto JSON.');
    const dto = plainToInstance(ContractDataDto, json);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length > 0) throw Errors.validation('Dados do contrato inválidos.', { errors: flattenErrors(errors) });
    return dto;
  }

  async create(auth: AuthContext, file: UploadedPdf | undefined, rawData: unknown, client: ClientInfo) {
    const data = await this.parseData(rawData);
    const template = await this.templates.findActiveByKey(auth, data.template);

    // Um signatário por papel do modelo.
    const byRole = new Map(data.signers.map((s) => [s.role, s]));
    if (byRole.size !== data.signers.length) throw Errors.validation('Cada papel deve aparecer uma única vez em "signers".');
    const unknown = [...byRole.keys()].filter((k) => !template.roles.some((r) => r.key === k));
    const missing = template.roles.filter((r) => !byRole.has(r.key)).map((r) => r.key);
    if (unknown.length > 0 || missing.length > 0) {
      throw Errors.validation('Informe exatamente um signatário para cada papel do modelo.', { missing, unknown });
    }

    // A empresa assina no momento do envio: precisa vir antes (ou junto) dos demais papéis.
    const companyRoles = template.roles.filter((r) => r.isCompany);
    const otherGroups = template.roles.filter((r) => !r.isCompany).map((r) => r.signingGroup);
    if (template.signingMode === 'SEQUENTIAL' && companyRoles.length > 0 && otherGroups.length > 0) {
      const firstOther = Math.min(...otherGroups);
      if (companyRoles.some((r) => r.signingGroup > firstOther)) {
        throw Errors.unprocessable(
          'TEMPLATE_ORDER_UNSUPPORTED',
          'Na integração, a empresa assina no envio: ajuste o modelo para que os papéis da empresa venham antes dos demais.',
        );
      }
    }
    if (companyRoles.length > 0) await this.requireAuthorization(auth.organizationId);

    const lockKey = `lock:contract:${auth.organizationId}:${sha256Hex(data.externalRef)}`;
    const lockValue = randomUUID();
    const locked = await this.redis.set(lockKey, lockValue, 'PX', LOCK_TTL_MS, 'NX');
    if (!locked) throw Errors.conflict('CONTRACT_IN_PROGRESS', 'Este contrato já está sendo processado. Tente novamente em instantes.');
    try {
      const existing = await this.prisma.envelope.findFirst({
        where: { organizationId: auth.organizationId, externalRef: data.externalRef, status: { notIn: CLOSED_STATUSES } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (existing) return await this.advance(auth, existing.id, client, true);

      // Âncoras conferidas ANTES de armazenar qualquer coisa.
      const pdf = await this.templates.assertPdfUpload(file);
      const { plan } = await this.templates.planPdf(template, pdf);
      if (!isPlanValid(plan)) {
        throw Errors.unprocessable('TEMPLATE_ANCHORS_MISMATCH', 'As âncoras do PDF não conferem com o modelo.', {
          missing_signature: plan.missingSignature,
          unknown_roles: plan.unknownRoles,
          invalid: plan.invalid.map((i) => ({ text: i.text, page: i.page })),
        });
      }
      const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { name: true } });
      const document = await this.documents.upload(auth, file, data.title, client);
      const envelopeId = await this.envelopes.createFromTemplate(
        auth,
        {
          title: data.title,
          message: data.message,
          expiresAt: data.expiresAt,
          externalRef: data.externalRef,
          templateId: template.id,
          signingMode: template.signingMode,
          documentId: document.id,
          signers: template.roles.map((r) => {
            const s = byRole.get(r.key)!;
            return {
              input: { name: s.name, email: s.email, cpf: s.cpf, phone: s.phone, signingGroup: r.signingGroup },
              internal: {
                roleKey: r.key,
                integration: r.isCompany ? { representing: data.representing ?? org.name, externalId: s.externalId ?? null } : undefined,
              },
            };
          }),
          fields: plan.fields.map((f) => ({ role: f.role, type: f.type, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height })),
        },
        client,
      );
      return await this.advance(auth, envelopeId, client, false);
    } finally {
      // Libera apenas o próprio lock.
      await this.redis
        .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockValue)
        .catch(() => undefined);
    }
  }

  /** Ativa (se rascunho), registra a assinatura da empresa pendente e emite os links da vez. */
  private async advance(auth: AuthContext, envelopeId: string, client: ClientInfo, replayed: boolean) {
    const env = await this.prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { status: true } });
    if (env.status === EnvelopeStatus.DRAFT) await this.envelopes.activate(auth, envelopeId, client);

    const pending = await this.prisma.signer.findMany({
      where: { envelopeId, authMethod: AuthMethod.INTEGRATION, status: { notIn: [...TERMINAL_SIGNER_STATUSES] } },
      orderBy: { signingGroup: 'asc' },
      select: { id: true },
    });
    if (pending.length > 0) {
      const current = await this.prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { status: true } });
      if (SIGNABLE_ENVELOPE_STATUSES.includes(current.status)) {
        const authorization = await this.requireAuthorization(auth.organizationId);
        const attestedBy = await this.attestedBy(auth);
        for (const s of pending) {
          await this.engine.signByIntegration({ envelopeId, signerId: s.id, actor: actorOf(auth), attestedBy, authorization, client });
        }
      }
    }
    const links = await this.issueTurnLinks(auth, envelopeId, client);
    return this.summary(auth, envelopeId, replayed, links);
  }

  private async requireAuthorization(organizationId: string): Promise<IntegrationSignContext['authorization']> {
    const active = await this.companySignature.findActive(organizationId);
    if (!active) {
      throw Errors.unprocessable(
        'COMPANY_SIGNATURE_NOT_AUTHORIZED',
        'A empresa ainda não autorizou a assinatura pela integração (Configurações → Assinatura da empresa).',
      );
    }
    return { id: active.id, authorizedById: active.authorizedById, authorizedAt: active.authorizedAt, legalText: active.legalTextVersion };
  }

  private async attestedBy(auth: AuthContext): Promise<IntegrationSignContext['attestedBy']> {
    if (auth.kind === 'api_key') {
      const key = await this.prisma.apiKey.findUnique({ where: { id: auth.apiKeyId }, select: { name: true } });
      return { type: 'api_key', id: auth.apiKeyId, name: key?.name ?? null };
    }
    const user = await this.prisma.user.findUnique({ where: { id: auth.userId }, select: { name: true } });
    return { type: 'user', id: auth.userId, name: user?.name ?? null };
  }

  /** Links individuais para os signatários (não-empresa) cuja vez já chegou. */
  private async issueTurnLinks(auth: AuthContext, envelopeId: string, client: ClientInfo) {
    return this.prisma.tx(async (tx) => {
      const env = await tx.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
      const links = new Map<string, { url: string; expiresAt: Date }>();
      if (!SIGNABLE_ENVELOPE_STATUSES.includes(env.status) || env.finalizationRequestedAt) return links;
      const signers = await tx.signer.findMany({ where: { envelopeId } });
      for (const s of signers) {
        if (s.authMethod === AuthMethod.INTEGRATION || TERMINAL_SIGNER_STATUSES.includes(s.status) || !isSignersTurn(signers, s.signingGroup)) continue;
        links.set(s.id, await this.issueLinkTx(tx, auth, env.id, env.expiresAt, s.id, client));
      }
      return links;
    });
  }

  private async issueLinkTx(tx: Tx, auth: AuthContext, envelopeId: string, envelopeExpiresAt: Date | null, signerId: string, client: ClientInfo) {
    const issued = await issueSignerAccessToken(tx, this.encryption, signerId, envelopeExpiresAt, this.config.SIGNER_LINK_TTL_DAYS);
    await this.audit.record(tx, {
      eventType: AuditEventType.SIGNING_LINK_ISSUED,
      actor: actorOf(auth),
      organizationId: auth.organizationId,
      envelopeId,
      signerId,
      ...client,
      metadata: { expiresAt: issued.expiresAt.toISOString() },
    });
    return { url: `${this.config.APP_PUBLIC_URL.replace(/\/+$/, '')}/sign/${issued.token}`, expiresAt: issued.expiresAt };
  }

  /**
   * Novo link individual de assinatura (ex.: para enviar por WhatsApp pelo sistema de origem).
   * Links anteriores continuam válidos até expirar.
   */
  async issueLink(auth: AuthContext, envelopeId: string, signerId: string, client: ClientInfo) {
    return this.prisma.tx(async (tx) => {
      const env = await tx.envelope.findFirst({ where: { id: envelopeId, organizationId: auth.organizationId } });
      if (!env) throw Errors.notFound('ENVELOPE_NOT_FOUND', 'Envelope não encontrado.');
      if (!SIGNABLE_ENVELOPE_STATUSES.includes(env.status) || env.finalizationRequestedAt) {
        throw Errors.conflict('ENVELOPE_NOT_ACTIVE', 'Envelope não está aguardando assinaturas.');
      }
      const signers = await tx.signer.findMany({ where: { envelopeId } });
      const signer = signers.find((s) => s.id === signerId);
      if (!signer) throw Errors.notFound('SIGNER_NOT_FOUND', 'Signatário não encontrado.');
      if (signer.authMethod === AuthMethod.INTEGRATION || TERMINAL_SIGNER_STATUSES.includes(signer.status)) {
        throw Errors.conflict('SIGNER_NOT_PENDING', 'Este signatário não tem assinatura pendente.');
      }
      if (!isSignersTurn(signers, signer.signingGroup)) throw Errors.conflict('NOT_YOUR_TURN', 'Ainda não é a vez deste signatário.');
      const link = await this.issueLinkTx(tx, auth, env.id, env.expiresAt, signer.id, client);
      return { signerId: signer.id, signingUrl: link.url, expiresAt: link.expiresAt };
    });
  }

  private async summary(auth: AuthContext, envelopeId: string, replayed: boolean, links: Map<string, { url: string; expiresAt: Date }>) {
    const env = await this.envelopes.get(auth, envelopeId);
    return {
      id: env.id,
      status: env.status,
      externalRef: env.externalRef,
      validationCode: env.validationCode,
      replayed,
      documents: env.documents.map((d) => ({ id: d.id, filename: d.filename, originalSha256: d.originalSha256 })),
      signers: env.signers.map((s) => ({
        id: s.id,
        role: s.roleKey,
        name: s.name,
        email: s.email,
        status: s.status,
        signedAt: s.signedAt,
        signingUrl: links.get(s.id)?.url ?? null,
        signingUrlExpiresAt: links.get(s.id)?.expiresAt ?? null,
      })),
    };
  }
}
