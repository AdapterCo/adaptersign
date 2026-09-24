import { Body, Controller, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Length, Matches, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { ActorType, Prisma, SubscriptionStatus, WebhookDeliveryStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { QueueNames, QueueService, type QueueName } from '../../infra/queue/queues';
import { Errors } from '../../common/errors/app-error';
import { CurrentAuth, PlatformAdminOnly, UserOnly } from '../../common/auth/decorators';
import type { AuthContext } from '../../common/auth/auth-context';
import { clientInfo, type ClientInfo } from '../../common/http/client-info';
import { PaginationQueryDto, paginated, resolvePagination } from '../../common/util/pagination';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { UsageService } from '../billing/usage.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhooksModule } from '../webhooks/webhooks.module';

class SearchQuery extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

class PlanDto {
  @ApiProperty({ example: 'STARTER' })
  @Matches(/^[A-Z][A-Z0-9_]{1,30}$/)
  code: string;

  @ApiProperty()
  @IsString()
  @Length(2, 60)
  name: string;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(0) monthlyEnvelopes?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(0) monthlyDocuments?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'bytes (string para valores grandes)' }) @IsOptional() @Matches(/^\d+$/) storageLimitBytes?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) usersLimit?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() apiAccess?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() webhooks?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() branding?: boolean;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) retentionDays?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(0) priceCents?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

class SubscriptionDto {
  @ApiProperty() @Matches(/^[A-Z][A-Z0-9_]{1,30}$/) planCode: string;
  @ApiProperty({ enum: SubscriptionStatus }) @IsEnum(SubscriptionStatus) status: SubscriptionStatus;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() currentPeriodEnd?: string;
}

class QueueParam {
  @IsIn(Object.values(QueueNames)) queue: QueueName;
  @IsOptional() @IsString() @MaxLength(200) jobId?: string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly webhooks: WebhooksService,
  ) {}

  private actor(auth: AuthContext) {
    return { type: ActorType.PLATFORM_ADMIN, id: auth.kind === 'user' ? auth.userId : null };
  }

  async metrics() {
    const [orgs, users, envelopes, signatures, storage, deliveries, notificationsFailed, outboxPending, queueCounts] = await Promise.all([
      this.prisma.organization.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.envelope.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.signature.count(),
      this.prisma.documentVersion.aggregate({ _sum: { sizeBytes: true } }),
      this.prisma.webhookDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.notification.count({ where: { status: 'FAILED' } }),
      this.prisma.outboxEvent.count({ where: { processedAt: null } }),
      Promise.all(
        Object.values(QueueNames).map(async (q) => [q, await this.queues.queues[q].getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')] as const),
      ),
    ]);
    return {
      organizations: orgs,
      users,
      envelopes: Object.fromEntries(envelopes.map((e) => [e.status, e._count._all])),
      signatures,
      storageBytes: (storage._sum.sizeBytes ?? 0n).toString(),
      webhookDeliveries: Object.fromEntries(deliveries.map((d) => [d.status, d._count._all])),
      notificationsFailed,
      outboxPending,
      queues: Object.fromEntries(queueCounts),
    };
  }

  async organizations(q: SearchQuery) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const where: Prisma.OrganizationWhereInput = q.search
      ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { slug: { contains: q.search.toLowerCase() } }] }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          deletedAt: true,
          subscription: { select: { status: true, plan: { select: { code: true } } } },
          _count: { select: { members: true, envelopes: true } },
        },
      }),
    ]);
    const data = await Promise.all(rows.map(async (r) => ({ ...r, usage: await this.usage.summary(r.id) })));
    return paginated(data, total, page, pageSize);
  }

  async users(q: SearchQuery) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const where: Prisma.UserWhereInput = q.search
      ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { email: { contains: q.search.toLowerCase() } }] }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: { id: true, name: true, email: true, emailVerifiedAt: true, isPlatformAdmin: true, createdAt: true, deletedAt: true, _count: { select: { memberships: true } } },
      }),
    ]);
    return paginated(rows, total, page, pageSize);
  }

  /** Somente metadados: sem títulos, documentos ou dados de signatários. */
  async envelopes(q: PaginationQueryDto) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const [total, rows] = await Promise.all([
      this.prisma.envelope.count(),
      this.prisma.envelope.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: { id: true, organizationId: true, status: true, createdAt: true, completedAt: true, _count: { select: { documents: true, signers: true } } },
      }),
    ]);
    return paginated(rows, total, page, pageSize);
  }

  plans() {
    return this.prisma.plan.findMany({ orderBy: { createdAt: 'asc' } }).then((rows) => rows.map((p) => ({ ...p, storageLimitBytes: p.storageLimitBytes?.toString() ?? null })));
  }

  private planData(dto: PlanDto) {
    return {
      code: dto.code,
      name: dto.name,
      monthlyEnvelopes: dto.monthlyEnvelopes ?? null,
      monthlyDocuments: dto.monthlyDocuments ?? null,
      storageLimitBytes: dto.storageLimitBytes ? BigInt(dto.storageLimitBytes) : null,
      usersLimit: dto.usersLimit ?? null,
      apiAccess: dto.apiAccess ?? false,
      webhooks: dto.webhooks ?? false,
      branding: dto.branding ?? false,
      retentionDays: dto.retentionDays ?? null,
      priceCents: dto.priceCents ?? null,
      currency: dto.currency ?? null,
      active: dto.active ?? true,
    };
  }

  async upsertPlan(auth: AuthContext, dto: PlanDto, client: ClientInfo, id?: string) {
    return this.prisma.tx(async (tx) => {
      const data = this.planData(dto);
      const plan = id ? await tx.plan.update({ where: { id }, data }) : await tx.plan.create({ data });
      await this.audit.record(tx, {
        eventType: AuditEventType.PLATFORM_PLAN_CHANGED,
        actor: this.actor(auth),
        ...client,
        metadata: { planId: plan.id, ...data, storageLimitBytes: data.storageLimitBytes?.toString() ?? null },
      });
      return { ...plan, storageLimitBytes: plan.storageLimitBytes?.toString() ?? null };
    });
  }

  async setSubscription(auth: AuthContext, organizationId: string, dto: SubscriptionDto, client: ClientInfo) {
    return this.prisma.tx(async (tx) => {
      const plan = await tx.plan.findUnique({ where: { code: dto.planCode } });
      if (!plan) throw Errors.notFound('PLAN_NOT_FOUND', 'Plano não encontrado.');
      const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
      if (!org) throw Errors.notFound('ORGANIZATION_NOT_FOUND', 'Organização não encontrada.');
      const data = {
        planId: plan.id,
        status: dto.status,
        provider: 'manual',
        currentPeriodEnd: dto.currentPeriodEnd ? new Date(dto.currentPeriodEnd) : null,
      };
      const sub = await tx.subscription.upsert({
        where: { organizationId },
        create: { organizationId, currentPeriodStart: new Date(), ...data },
        update: data,
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.PLATFORM_SUBSCRIPTION_CHANGED,
        actor: this.actor(auth),
        organizationId,
        ...client,
        metadata: { planCode: plan.code, status: dto.status, currentPeriodEnd: data.currentPeriodEnd },
      });
      return sub;
    });
  }

  async webhookFailures(q: PaginationQueryDto) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const where = { status: { in: [WebhookDeliveryStatus.DEAD, WebhookDeliveryStatus.RETRYING] } };
    const [total, rows] = await Promise.all([
      this.prisma.webhookDelivery.count({ where }),
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
        select: { id: true, organizationId: true, endpointId: true, eventType: true, status: true, attempts: true, lastStatusCode: true, lastError: true, updatedAt: true },
      }),
    ]);
    return paginated(rows, total, page, pageSize);
  }

  async retryWebhook(auth: AuthContext, deliveryId: string, client: ClientInfo) {
    await this.webhooks.redeliver(null, deliveryId);
    await this.audit.recordStandalone({ eventType: AuditEventType.PLATFORM_WEBHOOK_RETRIED, actor: this.actor(auth), ...client, metadata: { deliveryId } });
  }

  async failedJobs(queue: QueueName) {
    const jobs = await this.queues.queues[queue].getFailed(0, 49);
    return jobs.map((j) => ({ id: j.id, name: j.name, attemptsMade: j.attemptsMade, failedReason: j.failedReason, timestamp: j.timestamp, finishedOn: j.finishedOn }));
  }

  async retryJob(queue: QueueName, jobId: string) {
    const job = await this.queues.queues[queue].getJob(jobId);
    if (!job) throw Errors.notFound('JOB_NOT_FOUND', 'Job não encontrado.');
    await job.retry();
  }

  async failedOutbox(q: PaginationQueryDto) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const where = { processedAt: null, attempts: { gt: 0 } };
    const [total, rows] = await Promise.all([
      this.prisma.outboxEvent.count({ where }),
      this.prisma.outboxEvent.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take, select: { id: true, type: true, organizationId: true, attempts: true, lastError: true, createdAt: true } }),
    ]);
    return paginated(rows, total, page, pageSize);
  }
}

@ApiTags('admin')
@UserOnly()
@PlatformAdminOnly()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Métricas da plataforma (sem conteúdo de documentos)' })
  metrics() {
    return this.admin.metrics();
  }

  @Get('organizations')
  organizations(@Query() q: SearchQuery) {
    return this.admin.organizations(q);
  }

  @Put('organizations/:id/subscription')
  setSubscription(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubscriptionDto, @Req() req: Request) {
    return this.admin.setSubscription(auth, id, dto, clientInfo(req));
  }

  @Get('users')
  users(@Query() q: SearchQuery) {
    return this.admin.users(q);
  }

  @Get('envelopes')
  envelopes(@Query() q: PaginationQueryDto) {
    return this.admin.envelopes(q);
  }

  @Get('plans')
  plans() {
    return this.admin.plans();
  }

  @Post('plans')
  createPlan(@CurrentAuth() auth: AuthContext, @Body() dto: PlanDto, @Req() req: Request) {
    return this.admin.upsertPlan(auth, dto, clientInfo(req));
  }

  @Patch('plans/:id')
  updatePlan(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlanDto, @Req() req: Request) {
    return this.admin.upsertPlan(auth, dto, clientInfo(req), id);
  }

  @Get('webhooks/failures')
  webhookFailures(@Query() q: PaginationQueryDto) {
    return this.admin.webhookFailures(q);
  }

  @HttpCode(202)
  @Post('webhooks/deliveries/:id/retry')
  async retryWebhook(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.admin.retryWebhook(auth, id, clientInfo(req));
    return { ok: true };
  }

  @Get('queues/:queue/failed')
  failedJobs(@Param() p: QueueParam) {
    return this.admin.failedJobs(p.queue);
  }

  @HttpCode(202)
  @Post('queues/:queue/jobs/:jobId/retry')
  async retryJob(@Param() p: QueueParam) {
    if (!p.jobId) throw Errors.validation('jobId obrigatório.');
    await this.admin.retryJob(p.queue, p.jobId);
    return { ok: true };
  }

  @Get('outbox/failed')
  failedOutbox(@Query() q: PaginationQueryDto) {
    return this.admin.failedOutbox(q);
  }
}

@Module({ imports: [WebhooksModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
