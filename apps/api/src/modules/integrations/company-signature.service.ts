import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { Errors } from '../../common/errors/app-error';
import type { ClientInfo } from '../../common/http/client-info';
import { actorOf, type AuthContext } from '../../common/auth/auth-context';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { LegalService } from '../legal/legal.service';

/**
 * Autorização da organização (dada por um OWNER, uma vez) para que as integrações registrem a
 * assinatura da própria empresa em nome do representante informado pelo sistema de origem.
 * Há no máximo uma autorização vigente por organização; revogar bloqueia novos envios.
 */
@Injectable()
export class CompanySignatureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly legal: LegalService,
  ) {}

  /** Autorização vigente (com o texto aceito), ou null. */
  async findActive(organizationId: string) {
    return this.prisma.companySignatureAuthorization.findFirst({
      where: { organizationId, revokedAt: null },
      orderBy: { authorizedAt: 'desc' },
      include: { legalTextVersion: { select: { id: true, version: true, sha256: true } } },
    });
  }

  async status(auth: AuthContext) {
    const [active, text] = await Promise.all([this.findActive(auth.organizationId), this.legal.currentCompanySignatureAuthorization()]);
    const by = active ? await this.prisma.user.findUnique({ where: { id: active.authorizedById }, select: { name: true } }) : null;
    return {
      authorized: !!active,
      authorizedAt: active?.authorizedAt ?? null,
      authorizedBy: by?.name ?? null,
      acceptedVersion: active?.legalTextVersion.version ?? null,
      text: { version: text.version, content: text.content, sha256: text.sha256 },
    };
  }

  async authorize(auth: AuthContext, version: string, client: ClientInfo) {
    if (auth.kind !== 'user') throw Errors.forbidden();
    const text = await this.legal.currentCompanySignatureAuthorization();
    if (version !== text.version) {
      throw Errors.unprocessable('CONSENT_VERSION_MISMATCH', 'O texto da autorização foi atualizado. Recarregue a página.');
    }
    await this.prisma.tx(async (tx) => {
      // Serializa por organização: nunca duas autorizações vigentes.
      await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${auth.organizationId}::uuid FOR UPDATE`;
      const now = new Date();
      await tx.companySignatureAuthorization.updateMany({
        where: { organizationId: auth.organizationId, revokedAt: null },
        data: { revokedAt: now, revokedById: auth.userId },
      });
      const row = await tx.companySignatureAuthorization.create({
        data: {
          organizationId: auth.organizationId,
          legalTextVersionId: text.id,
          authorizedById: auth.userId,
          authorizedAt: now,
          ip: client.ip,
          userAgent: client.userAgent,
        },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.COMPANY_SIGNATURE_AUTHORIZED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { authorizationId: row.id, textVersion: text.version, textSha256: text.sha256 },
      });
    });
    return this.status(auth);
  }

  async revoke(auth: AuthContext, client: ClientInfo) {
    if (auth.kind !== 'user') throw Errors.forbidden();
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${auth.organizationId}::uuid FOR UPDATE`;
      const res = await tx.companySignatureAuthorization.updateMany({
        where: { organizationId: auth.organizationId, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: auth.userId },
      });
      if (res.count > 0) {
        await this.audit.record(tx, {
          eventType: AuditEventType.COMPANY_SIGNATURE_REVOKED,
          actor: actorOf(auth),
          organizationId: auth.organizationId,
          ...client,
          metadata: {},
        });
      }
    });
    return this.status(auth);
  }
}
