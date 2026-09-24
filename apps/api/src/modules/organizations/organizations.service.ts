import { Injectable } from '@nestjs/common';
import { MemberRole } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { randomToken } from '../../common/crypto/crypto.util';
import { Errors } from '../../common/errors/app-error';
import { normalizeEmail } from '../../common/util/text';
import type { ClientInfo } from '../../common/http/client-info';
import { actorOf, ROLE_RANK, type AuthContext } from '../../common/auth/auth-context';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { OutboxService } from '../outbox/outbox.service';
import { DomainEvent } from '../outbox/domain-events';
import { LimitsService } from '../billing/limits.service';
import { PlansService } from '../billing/plans.service';
import { UsageService } from '../billing/usage.service';
import { PasswordService } from '../auth/password.service';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly limits: LimitsService,
    private readonly plans: PlansService,
    private readonly usage: UsageService,
    private readonly passwords: PasswordService,
  ) {}

  async current(auth: AuthContext) {
    const org = await this.prisma.organization.findFirstOrThrow({
      where: { id: auth.organizationId, deletedAt: null },
      select: { id: true, name: true, slug: true, createdAt: true, retentionDays: true },
    });
    const plan = await this.plans.planForOrganization(auth.organizationId);
    const usage = await this.usage.summary(auth.organizationId);
    return {
      ...org,
      plan: {
        code: plan.code,
        name: plan.name,
        limits: {
          monthlyEnvelopes: plan.monthlyEnvelopes,
          monthlyDocuments: plan.monthlyDocuments,
          storageLimitBytes: plan.storageLimitBytes?.toString() ?? null,
          usersLimit: plan.usersLimit,
          apiAccess: plan.apiAccess,
          webhooks: plan.webhooks,
          branding: plan.branding,
        },
      },
      usage,
    };
  }

  async update(auth: AuthContext, name: string, client: ClientInfo) {
    return this.prisma.tx(async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { name: true } });
      const org = await tx.organization.update({ where: { id: auth.organizationId }, data: { name: name.trim() }, select: { id: true, name: true } });
      await this.audit.record(tx, {
        eventType: AuditEventType.ORGANIZATION_SETTINGS_CHANGED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { field: 'name', from: before.name, to: org.name },
      });
      return org;
    });
  }

  async members(auth: AuthContext) {
    const rows = await this.prisma.organizationMember.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, createdAt: true, user: { select: { id: true, name: true, email: true, emailVerifiedAt: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      createdAt: r.createdAt,
      user: { id: r.user.id, name: r.user.name, email: r.user.email, emailVerified: !!r.user.emailVerifiedAt },
    }));
  }

  private assertCanAssign(auth: AuthContext, role: MemberRole): void {
    // Somente OWNER atribui/manipula OWNER; ninguém atribui papel acima do próprio.
    if (ROLE_RANK[role] > ROLE_RANK[auth.role]) throw Errors.forbidden('Não é possível atribuir papel superior ao seu.');
    if (role === MemberRole.OWNER && auth.role !== MemberRole.OWNER) throw Errors.forbidden();
  }

  async invite(auth: AuthContext, input: { email: string; name: string; role: MemberRole }, client: ClientInfo) {
    this.assertCanAssign(auth, input.role);
    const email = normalizeEmail(input.email);
    const placeholderHash = await this.passwords.hash(randomToken(32));
    const { memberId, event } = await this.prisma.tx(async (tx) => {
      await this.limits.assertCanAddMember(tx, auth.organizationId);
      let user = await tx.user.findUnique({ where: { email }, select: { id: true, deletedAt: true } });
      let created = false;
      if (user?.deletedAt) throw Errors.conflict('USER_UNAVAILABLE', 'Este usuário não pode ser adicionado.');
      if (!user) {
        // Conta criada com senha aleatória inutilizável; o convidado define a senha pelo link.
        user = await tx.user.create({ data: { email, name: input.name.trim(), passwordHash: placeholderHash }, select: { id: true, deletedAt: true } });
        created = true;
      }
      const existing = await tx.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: auth.organizationId, userId: user.id } },
      });
      if (existing) throw Errors.conflict('ALREADY_MEMBER', 'Usuário já é membro da organização.');
      const member = await tx.organizationMember.create({ data: { organizationId: auth.organizationId, userId: user.id, role: input.role } });
      await this.audit.record(tx, {
        eventType: AuditEventType.USER_INVITED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { memberId: member.id, userId: user.id, role: input.role, newAccount: created },
      });
      const event = await this.outbox.emit(tx, {
        type: DomainEvent.USER_PASSWORD_RESET_REQUESTED,
        organizationId: auth.organizationId,
        payload: { userId: user.id, invitation: true, newAccount: created, organizationId: auth.organizationId },
        requestId: client.requestId,
      });
      return { memberId: member.id, event };
    });
    await this.outbox.dispatch(event);
    return { id: memberId };
  }

  async changeRole(auth: AuthContext, memberId: string, role: MemberRole, client: ClientInfo) {
    this.assertCanAssign(auth, role);
    await this.prisma.tx(async (tx) => {
      const member = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId: auth.organizationId } });
      if (!member) throw Errors.notFound('MEMBER_NOT_FOUND', 'Membro não encontrado.');
      if (member.role === MemberRole.OWNER && auth.role !== MemberRole.OWNER) throw Errors.forbidden();
      if (member.role === MemberRole.OWNER && role !== MemberRole.OWNER) await this.assertNotLastOwner(tx, auth.organizationId);
      await tx.organizationMember.update({ where: { id: member.id }, data: { role } });
      await this.audit.record(tx, {
        eventType: AuditEventType.ROLE_CHANGED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { memberId, userId: member.userId, from: member.role, to: role },
      });
    });
  }

  async remove(auth: AuthContext, memberId: string, client: ClientInfo) {
    await this.prisma.tx(async (tx) => {
      const member = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId: auth.organizationId } });
      if (!member) throw Errors.notFound('MEMBER_NOT_FOUND', 'Membro não encontrado.');
      if (member.role === MemberRole.OWNER) {
        if (auth.role !== MemberRole.OWNER) throw Errors.forbidden();
        await this.assertNotLastOwner(tx, auth.organizationId);
      }
      await tx.organizationMember.delete({ where: { id: member.id } });
      // Encerra sessões do usuário nesta organização.
      await tx.session.updateMany({
        where: { userId: member.userId, organizationId: auth.organizationId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'membership_removed' },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.MEMBER_REMOVED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { memberId, userId: member.userId, role: member.role },
      });
    });
  }

  private async assertNotLastOwner(tx: Tx, organizationId: string) {
    const owners = await tx.organizationMember.count({ where: { organizationId, role: MemberRole.OWNER } });
    if (owners <= 1) throw Errors.unprocessable('LAST_OWNER', 'A organização precisa de ao menos um OWNER.');
  }
}
