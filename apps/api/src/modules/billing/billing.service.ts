import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ActorType,
  BillingPaymentKind,
  BillingPaymentStatus,
  UsageMetric,
  type BillingPayment,
  type CreditPack,
  type Plan,
} from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Errors } from '../../common/errors/app-error';
import type { ClientInfo } from '../../common/http/client-info';
import { actorOf, type AuthContext } from '../../common/auth/auth-context';
import { RateLimitService } from '../../common/rate-limit/rate-limit';
import { type PaginationQueryDto, paginated, resolvePagination } from '../../common/util/pagination';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../audit/audit-events';
import { PlansService } from './plans.service';
import { UsageService } from './usage.service';
import { BILLING_PROVIDER, type BillingProvider, type ProviderPayment } from './billing-provider';
import { envelopeQuota, mapProviderStatus, nextPeriod } from './billing-period';

const CHECKOUT_TTL_MS = 24 * 3600 * 1000;
const OPEN_STATUSES: BillingPaymentStatus[] = [BillingPaymentStatus.PENDING, BillingPaymentStatus.IN_PROCESS];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PaymentView = BillingPayment & { plan: Pick<Plan, 'code' | 'name'> | null; creditPack: Pick<CreditPack, 'code' | 'name'> | null };
const viewInclude = { plan: { select: { code: true, name: true } }, creditPack: { select: { code: true, name: true } } } as const;

export type CheckoutItem = { planCode: string } | { packCode: string };

/**
 * Contratação de planos (pré-pago, mensal) e de pacotes de documentos extras. O navegador só
 * recebe a URL da página de pagamento do provedor; plano e créditos são liberados exclusivamente
 * aqui, após consultar o pagamento no provedor e conferir referência, valor e moeda.
 * Notificações do provedor servem apenas de gatilho.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimitService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ───────────── Consulta ─────────────

  async overview(auth: AuthContext) {
    const [sub, current, catalog, packs, usage, used, org] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { organizationId: auth.organizationId } }),
      this.plans.planForOrganization(auth.organizationId),
      this.prisma.plan.findMany({ where: { active: true }, orderBy: [{ priceCents: { sort: 'asc', nulls: 'last' } }, { code: 'asc' }] }),
      this.prisma.creditPack.findMany({ where: { active: true }, orderBy: { documents: 'asc' } }),
      this.usage.summary(auth.organizationId),
      this.usage.current(auth.organizationId, UsageMetric.ENVELOPES_CREATED),
      this.prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { extraDocumentCredits: true } }),
    ]);
    const now = new Date();
    const paidActive = !!sub && sub.planId === current.id && sub.status === 'ACTIVE';
    const canBuyCredits = this.provider.available && this.plans.isPaidPlan(current);
    return {
      onlinePayment: this.provider.available,
      current: {
        code: current.code,
        name: current.name,
        paid: this.plans.isPaidPlan(current),
        periodEnd: paidActive ? sub.currentPeriodEnd : null,
        // Plano pago vencido: a organização voltou ao plano padrão.
        expired: !!sub && sub.status === 'ACTIVE' && !!sub.currentPeriodEnd && sub.currentPeriodEnd <= now,
      },
      quota: envelopeQuota(current, Number(used), org.extraDocumentCredits),
      usage,
      plans: catalog.map((p) => ({
        code: p.code,
        name: p.name,
        priceCents: p.priceCents,
        currency: p.currency,
        purchasable: this.provider.available && this.isPurchasablePlan(p),
        bonusPercent: p.overageBonusPercent,
        limits: {
          monthlyEnvelopes: p.monthlyEnvelopes,
          storageBytes: p.storageLimitBytes === null ? null : p.storageLimitBytes.toString(),
          users: p.usersLimit,
          apiAccess: p.apiAccess,
          webhooks: p.webhooks,
        },
      })),
      creditPacks: packs.map((k) => ({
        code: k.code,
        name: k.name,
        documents: k.documents,
        priceCents: k.priceCents,
        currency: k.currency,
        purchasable: canBuyCredits && this.isPurchasablePack(k),
      })),
    };
  }

  private isPurchasablePlan(p: Plan): boolean {
    return p.active && !!p.priceCents && p.priceCents > 0 && p.currency === 'BRL' && this.plans.isPaidPlan(p);
  }

  private isPurchasablePack(k: CreditPack): boolean {
    return k.active && k.priceCents > 0 && k.documents > 0 && k.currency === 'BRL';
  }

  private serialize(p: PaymentView) {
    return {
      id: p.id,
      kind: p.kind,
      plan: p.plan ? { code: p.plan.code, name: p.plan.name } : null,
      creditPack: p.creditPack ? { code: p.creditPack.code, name: p.creditPack.name } : null,
      documents: p.documents,
      // Checkout não pago dentro do prazo aparece como expirado (um pagamento tardio ainda é aceito).
      status: p.status === BillingPaymentStatus.PENDING && p.expiresAt <= new Date() ? BillingPaymentStatus.EXPIRED : p.status,
      amountCents: p.amountCents,
      currency: p.currency,
      paymentType: p.paymentType,
      approvedAt: p.approvedAt,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      createdAt: p.createdAt,
    };
  }

  async list(auth: AuthContext, q: PaginationQueryDto) {
    const { page, pageSize, skip, take } = resolvePagination(q);
    const where = { organizationId: auth.organizationId };
    const [total, rows] = await Promise.all([
      this.prisma.billingPayment.count({ where }),
      this.prisma.billingPayment.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: viewInclude }),
    ]);
    return paginated(
      rows.map((r) => this.serialize(r)),
      total,
      page,
      pageSize,
    );
  }

  /** Situação de um pagamento; se ainda em aberto, reconsulta o provedor (cobre notificações perdidas). */
  async get(auth: AuthContext, id: string) {
    const load = () => this.prisma.billingPayment.findFirst({ where: { id, organizationId: auth.organizationId }, include: viewInclude });
    let row = await load();
    if (!row) throw Errors.notFound('PAYMENT_NOT_FOUND', 'Pagamento não encontrado.');
    if (OPEN_STATUSES.includes(row.status) && this.provider.available) {
      const throttled = await this.limiter.consume('billing_reconcile', row.id).then(
        () => false,
        () => true,
      );
      if (!throttled) {
        await this.reconcile(row.id).catch((err: unknown) => this.logger.warn({ event: 'billing_reconcile_failed', paymentId: id, error: String(err) }));
        row = (await load())!;
      }
    }
    return this.serialize(row);
  }

  // ───────────── Contratação ─────────────

  async checkout(auth: AuthContext, item: CheckoutItem, client: ClientInfo) {
    if (auth.kind !== 'user') throw Errors.forbidden();
    if (!this.provider.available) {
      throw Errors.unavailable('BILLING_PROVIDER_NOT_CONFIGURED', 'Pagamento online ainda não está disponível. Contate o suporte.');
    }
    await this.limiter.consume('billing_checkout', auth.organizationId);

    // Produto, valor e moeda vêm do banco — nunca do navegador.
    let product: { kind: BillingPaymentKind; planId: string | null; creditPackId: string | null; documents: number | null; amountCents: number; currency: string; title: string; code: string };
    if ('planCode' in item) {
      const plan = await this.prisma.plan.findUnique({ where: { code: item.planCode } });
      if (!plan || !this.isPurchasablePlan(plan)) throw Errors.notFound('PLAN_NOT_FOUND', 'Plano indisponível para contratação.');
      product = {
        kind: BillingPaymentKind.PLAN,
        planId: plan.id,
        creditPackId: null,
        documents: null,
        amountCents: plan.priceCents!,
        currency: plan.currency!,
        title: `plano ${plan.name} (1 mês)`,
        code: plan.code,
      };
    } else {
      const pack = await this.prisma.creditPack.findUnique({ where: { code: item.packCode } });
      if (!pack || !this.isPurchasablePack(pack)) throw Errors.notFound('CREDIT_PACK_NOT_FOUND', 'Pacote indisponível.');
      const current = await this.plans.planForOrganization(auth.organizationId);
      if (!this.plans.isPaidPlan(current)) {
        throw Errors.unprocessable('PAID_PLAN_REQUIRED', 'Documentos extras estão disponíveis para quem tem um plano ativo. Contrate um plano.');
      }
      product = {
        kind: BillingPaymentKind.CREDITS,
        planId: null,
        creditPackId: pack.id,
        documents: pack.documents,
        amountCents: pack.priceCents,
        currency: pack.currency,
        title: `${pack.documents} documentos extras`,
        code: pack.code,
      };
    }

    const [user, org] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { email: true } }),
      this.prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { name: true } }),
    ]);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);
    await this.prisma.tx(async (tx) => {
      await tx.billingPayment.create({
        data: {
          id,
          organizationId: auth.organizationId,
          kind: product.kind,
          planId: product.planId,
          creditPackId: product.creditPackId,
          documents: product.documents,
          createdById: auth.userId,
          provider: this.provider.name,
          amountCents: product.amountCents,
          currency: product.currency,
          periodMonths: 1,
          expiresAt,
        },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.BILLING_CHECKOUT_CREATED,
        actor: actorOf(auth),
        organizationId: auth.organizationId,
        ...client,
        metadata: { paymentId: id, kind: product.kind, code: product.code, amountCents: product.amountCents, currency: product.currency },
      });
    });

    const appUrl = this.config.APP_PUBLIC_URL.replace(/\/+$/, '');
    const apiUrl = this.config.API_PUBLIC_URL.replace(/\/+$/, '');
    try {
      const { checkoutId, url } = await this.provider.createCheckout({
        reference: id,
        title: `${this.config.BRAND_NAME} — ${product.title} — ${org.name}`.slice(0, 250),
        amountCents: product.amountCents,
        currency: product.currency,
        payerEmail: user.email,
        returnUrl: `${appUrl}/billing?payment=${id}`,
        notificationUrl: `${apiUrl}/api/v1/billing/webhooks/mercadopago`,
        expiresAt,
      });
      await this.prisma.billingPayment.update({ where: { id }, data: { providerCheckoutId: checkoutId } });
      // Somente o id interno e a URL da página de pagamento do provedor.
      return { paymentId: id, url };
    } catch (err) {
      await this.prisma.billingPayment.update({ where: { id }, data: { status: BillingPaymentStatus.CANCELLED, statusDetail: 'checkout_failed' } });
      throw err;
    }
  }

  // ───────────── Confirmação (backend ↔ provedor) ─────────────

  /** Notificação do provedor: só um gatilho — o pagamento é sempre reconsultado no provedor. */
  async handleNotification(paymentId: string): Promise<void> {
    const payment = await this.provider.getPayment(paymentId);
    if (!payment) return;
    await this.apply(payment, 'webhook');
  }

  async reconcile(billingPaymentId: string): Promise<void> {
    const payments = await this.provider.findPaymentsByReference(billingPaymentId);
    // Aprovados primeiro: um pagamento recusado seguido de um aprovado libera a compra.
    const ordered = [...payments].sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved'));
    for (const p of ordered) await this.apply(p, 'reconcile');
  }

  /** Aplica o estado de um pagamento do provedor. Idempotente e serializado por cobrança. */
  async apply(p: ProviderPayment, source: 'webhook' | 'reconcile'): Promise<void> {
    const ref = p.externalReference;
    if (!ref || !UUID.test(ref)) return;
    const next = mapProviderStatus(p.status);
    if (!next) return;

    await this.prisma.tx(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "billing_payments" WHERE "id" = ${ref}::uuid FOR UPDATE`;
      if (locked.length === 0) return;
      const rec = await tx.billingPayment.findUniqueOrThrow({ where: { id: ref } });
      const base = { actor: { type: ActorType.SYSTEM, id: `billing:${source}` }, organizationId: rec.organizationId };
      const providerInfo = {
        paymentId: rec.id,
        kind: rec.kind,
        providerPaymentId: p.id,
        status: p.status,
        statusDetail: p.statusDetail,
        paymentType: p.paymentType,
        paymentMethod: p.paymentMethod,
      };

      // Outro pagamento do provedor para a mesma cobrança já aprovada (ex.: pago duas vezes): não libera de novo.
      if (rec.status === BillingPaymentStatus.APPROVED && rec.providerPaymentId && rec.providerPaymentId !== p.id) {
        if (next === BillingPaymentStatus.APPROVED) {
          await this.audit.record(tx, { ...base, eventType: AuditEventType.BILLING_PAYMENT_MISMATCH, metadata: { ...providerInfo, reason: 'duplicate_payment' } });
          this.logger.warn({ event: 'billing_duplicate_payment', paymentId: rec.id, providerPaymentId: p.id });
        }
        return;
      }

      if (next === BillingPaymentStatus.APPROVED) {
        if (rec.status === BillingPaymentStatus.APPROVED || rec.status === BillingPaymentStatus.REFUNDED) return;
        if (p.amountCents !== rec.amountCents || p.currency !== rec.currency) {
          await this.audit.record(tx, {
            ...base,
            eventType: AuditEventType.BILLING_PAYMENT_MISMATCH,
            metadata: { ...providerInfo, reason: 'amount_mismatch', expected: rec.amountCents, received: p.amountCents, currency: p.currency },
          });
          this.logger.error({ event: 'billing_amount_mismatch', paymentId: rec.id, providerPaymentId: p.id });
          return;
        }
        await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${rec.organizationId}::uuid FOR UPDATE`;
        const now = new Date();
        const granted = rec.kind === BillingPaymentKind.PLAN ? await this.grantPlan(tx, rec, p.id, now) : await this.grantCredits(tx, rec);
        await tx.billingPayment.update({
          where: { id: rec.id },
          data: {
            status: BillingPaymentStatus.APPROVED,
            providerPaymentId: p.id,
            paymentType: p.paymentType,
            paymentMethod: p.paymentMethod,
            statusDetail: p.statusDetail,
            approvedAt: p.approvedAt ?? now,
            ...('start' in granted ? { periodStart: granted.start, periodEnd: granted.end } : {}),
          },
        });
        await this.audit.record(tx, {
          ...base,
          eventType: AuditEventType.BILLING_PAYMENT_APPROVED,
          metadata: { ...providerInfo, amountCents: p.amountCents, ...granted },
        });
        this.logger.log({ event: 'billing_payment_approved', paymentId: rec.id, kind: rec.kind, organizationId: rec.organizationId });
        return;
      }

      if (next === BillingPaymentStatus.REFUNDED) {
        if (rec.status === BillingPaymentStatus.REFUNDED) return;
        const wasApproved = rec.status === BillingPaymentStatus.APPROVED;
        await tx.billingPayment.update({ where: { id: rec.id }, data: { status: next, providerPaymentId: p.id, statusDetail: p.statusDetail } });
        let effect: Record<string, unknown> = {};
        if (wasApproved && rec.kind === BillingPaymentKind.PLAN) {
          // Estorno/contestação do pagamento que sustenta o período atual: plano pago suspenso.
          const sub = await tx.subscription.findUnique({ where: { organizationId: rec.organizationId } });
          const suspended = !!sub && sub.providerReference === p.id && sub.status === 'ACTIVE';
          if (suspended) await tx.subscription.update({ where: { organizationId: rec.organizationId }, data: { status: 'PAST_DUE' } });
          effect = { subscriptionSuspended: suspended };
        } else if (wasApproved && rec.kind === BillingPaymentKind.CREDITS) {
          // Retira os créditos ainda não usados desse pacote.
          const org = await tx.organization.findUniqueOrThrow({ where: { id: rec.organizationId }, select: { extraDocumentCredits: true } });
          const removed = Math.min(org.extraDocumentCredits, rec.documents ?? 0);
          if (removed > 0) await tx.organization.update({ where: { id: rec.organizationId }, data: { extraDocumentCredits: { decrement: removed } } });
          effect = { creditsRemoved: removed };
        }
        await this.audit.record(tx, { ...base, eventType: AuditEventType.BILLING_PAYMENT_REFUNDED, metadata: { ...providerInfo, ...effect } });
        return;
      }

      // Pendente, recusado ou cancelado: só atualiza enquanto a cobrança está em aberto.
      if (!OPEN_STATUSES.includes(rec.status) || rec.status === next) return;
      await tx.billingPayment.update({
        where: { id: rec.id },
        data: { status: next, paymentType: p.paymentType, paymentMethod: p.paymentMethod, statusDetail: p.statusDetail },
      });
      await this.audit.record(tx, { ...base, eventType: AuditEventType.BILLING_PAYMENT_UPDATED, metadata: providerInfo });
    });
  }

  private async grantPlan(tx: Tx, rec: BillingPayment, providerPaymentId: string, now: Date) {
    const sub = await tx.subscription.findUnique({ where: { organizationId: rec.organizationId } });
    const period = nextPeriod(sub, rec.planId!, rec.periodMonths, now);
    const data = {
      planId: rec.planId!,
      status: 'ACTIVE' as const,
      provider: rec.provider,
      providerReference: providerPaymentId,
      currentPeriodEnd: period.end,
      ...(period.extended ? {} : { currentPeriodStart: period.start }),
    };
    await tx.subscription.upsert({
      where: { organizationId: rec.organizationId },
      create: { organizationId: rec.organizationId, currentPeriodStart: period.start, ...data },
      update: data,
    });
    return period;
  }

  private async grantCredits(tx: Tx, rec: BillingPayment) {
    const org = await tx.organization.update({
      where: { id: rec.organizationId },
      data: { extraDocumentCredits: { increment: rec.documents! } },
      select: { extraDocumentCredits: true },
    });
    return { creditsAdded: rec.documents!, creditsBalance: org.extraDocumentCredits };
  }
}
