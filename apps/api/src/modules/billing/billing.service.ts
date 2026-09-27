import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
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
const PIX_TTL_MS = 30 * 60 * 1000;
/** Cobranças que ainda aceitam uma (nova) tentativa de pagamento. */
const PAYABLE_STATUSES: BillingPaymentStatus[] = [
  BillingPaymentStatus.PENDING,
  BillingPaymentStatus.IN_PROCESS,
  BillingPaymentStatus.REJECTED,
  BillingPaymentStatus.CANCELLED,
];
const OPEN_STATUSES: BillingPaymentStatus[] = [BillingPaymentStatus.PENDING, BillingPaymentStatus.IN_PROCESS];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PaymentView = BillingPayment & { plan: Pick<Plan, 'code' | 'name'> | null; creditPack: Pick<CreditPack, 'code' | 'name'> | null };
const viewInclude = { plan: { select: { code: true, name: true } }, creditPack: { select: { code: true, name: true } } } as const;

export type CheckoutItem = { planCode: string } | { packCode: string };

export interface CardInput {
  token: string;
  paymentMethodId: string;
  issuerId?: string;
  payerEmail?: string;
  identificationType?: 'CPF' | 'CNPJ';
  identificationNumber?: string;
}

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
      // Chave PÚBLICA do Mercado Pago (tokenização do cartão no navegador) — não é segredo.
      publicKey: this.provider.publicKey,
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
      statusDetail: p.statusDetail,
      payable: PAYABLE_STATUSES.includes(p.status) && p.expiresAt > new Date(),
      // Pix em aberto: QR Code e copia-e-cola (dados públicos para quem paga).
      pix:
        p.pixQrCode && p.pixExpiresAt && p.pixExpiresAt > new Date() && OPEN_STATUSES.includes(p.status)
          ? { qrCode: p.pixQrCode, qrCodeBase64: p.pixQrCodeBase64, expiresAt: p.pixExpiresAt }
          : null,
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

    // Pedido criado; o pagamento (Pix ou cartão) é feito em seguida, sempre pelo backend.
    return { paymentId: id, amountCents: product.amountCents, currency: product.currency, description: product.title };
  }

  private notificationUrl(): string {
    return `${this.config.API_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/billing/webhooks/mercadopago`;
  }

  /** Cobrança da organização que ainda aceita pagamento (valor e produto vêm do banco). */
  private async payable(auth: AuthContext, id: string) {
    if (auth.kind !== 'user') throw Errors.forbidden();
    if (!this.provider.available) throw Errors.unavailable('BILLING_PROVIDER_NOT_CONFIGURED', 'Pagamento online ainda não está disponível.');
    const rec = await this.prisma.billingPayment.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: { plan: { select: { name: true } }, organization: { select: { name: true } } },
    });
    if (!rec) throw Errors.notFound('PAYMENT_NOT_FOUND', 'Pagamento não encontrado.');
    if (rec.status === BillingPaymentStatus.APPROVED) throw Errors.conflict('PAYMENT_ALREADY_APPROVED', 'Este pagamento já foi aprovado.');
    if (!PAYABLE_STATUSES.includes(rec.status) || rec.expiresAt <= new Date()) {
      throw Errors.conflict('PAYMENT_EXPIRED', 'Esta cobrança expirou. Escolha o plano ou pacote novamente.');
    }
    const title = rec.kind === BillingPaymentKind.PLAN ? `plano ${rec.plan?.name ?? ''} (1 mês)` : `${rec.documents ?? 0} documentos extras`;
    const description = `${this.config.BRAND_NAME} — ${title} — ${rec.organization.name}`.slice(0, 250);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { email: true } });
    return { rec, description, userEmail: user.email };
  }

  /** Gera (ou reaproveita) o Pix da cobrança; o QR Code é exibido na tela do Adapter Sign. */
  async payWithPix(auth: AuthContext, id: string, client: ClientInfo) {
    const { rec, description, userEmail } = await this.payable(auth, id);
    const now = new Date();
    const reusable =
      rec.pixPaymentId && rec.pixQrCode && rec.pixExpiresAt && rec.pixExpiresAt.getTime() > now.getTime() + 60_000 && OPEN_STATUSES.includes(rec.status);
    if (reusable) return this.get(auth, id);
    await this.limiter.consume('billing_pay', auth.organizationId);
    const expiresAt = new Date(Math.min(now.getTime() + PIX_TTL_MS, rec.expiresAt.getTime()));
    const payment = await this.provider.createPixPayment({
      reference: rec.id,
      description,
      amountCents: rec.amountCents,
      notificationUrl: this.notificationUrl(),
      idempotencyKey: `pix-${rec.id}-${now.getTime()}`,
      payerEmail: userEmail,
      expiresAt,
    });
    if (!payment.pix || payment.amountCents !== rec.amountCents) {
      throw Errors.unavailable('PAYMENT_PROVIDER_ERROR', 'Não foi possível gerar o Pix. Tente novamente.');
    }
    await this.prisma.tx(async (tx) => {
      await tx.billingPayment.update({
        where: { id: rec.id },
        data: {
          status: BillingPaymentStatus.PENDING,
          statusDetail: null,
          pixPaymentId: payment.id,
          pixQrCode: payment.pix!.qrCode,
          pixQrCodeBase64: payment.pix!.qrCodeBase64,
          pixExpiresAt: payment.pix!.expiresAt ?? expiresAt,
        },
      });
      await this.audit.record(tx, {
        eventType: AuditEventType.BILLING_PAYMENT_UPDATED,
        actor: actorOf(auth),
        organizationId: rec.organizationId,
        ...client,
        metadata: { paymentId: rec.id, providerPaymentId: payment.id, method: 'pix', action: 'pix_created' },
      });
    });
    return this.get(auth, id);
  }

  /**
   * Cartão (crédito/débito à vista): o navegador envia apenas o TOKEN de uso único gerado pelo
   * componente do Mercado Pago. Valor, parcelas (1) e descrição são definidos aqui.
   */
  async payWithCard(auth: AuthContext, id: string, input: CardInput, client: ClientInfo) {
    const { rec, description, userEmail } = await this.payable(auth, id);
    await this.limiter.consume('billing_pay', auth.organizationId);
    const idDigits = input.identificationNumber?.replace(/\D/g, '') ?? '';
    const identification = input.identificationType && idDigits ? { type: input.identificationType, number: idDigits } : null;
    await this.prisma.billingPayment.update({ where: { id: rec.id }, data: { status: BillingPaymentStatus.PENDING, statusDetail: null } });
    const payment = await this.provider.createCardPayment({
      reference: rec.id,
      description,
      amountCents: rec.amountCents,
      notificationUrl: this.notificationUrl(),
      // A mesma tentativa (mesmo token) nunca cobra duas vezes.
      idempotencyKey: `card-${rec.id}-${createHash('sha256').update(input.token).digest('hex').slice(0, 32)}`,
      token: input.token,
      paymentMethodId: input.paymentMethodId,
      issuerId: input.issuerId ?? null,
      payer: { email: input.payerEmail ?? userEmail, identification },
    });
    await this.audit.recordStandalone({
      eventType: AuditEventType.BILLING_PAYMENT_UPDATED,
      actor: actorOf(auth),
      organizationId: rec.organizationId,
      ...client,
      metadata: { paymentId: rec.id, providerPaymentId: payment.id, method: 'card', status: payment.status, statusDetail: payment.statusDetail },
    });
    await this.settle(payment, 'card');
    return this.get(auth, id);
  }

  /** Aplica o pagamento e, se aprovado, cancela outras tentativas pendentes (ex.: Pix gerado antes). */
  private async settle(payment: ProviderPayment, source: 'webhook' | 'reconcile' | 'card'): Promise<void> {
    await this.apply(payment, source);
    if (payment.status !== 'approved' || !payment.externalReference) return;
    const others = await this.provider.findPaymentsByReference(payment.externalReference).catch(() => []);
    for (const o of others) {
      if (o.id !== payment.id && (o.status === 'pending' || o.status === 'in_process')) {
        await this.provider
          .cancelPayment(o.id)
          .catch((err: unknown) => this.logger.warn({ event: 'billing_cancel_pending_failed', providerPaymentId: o.id, error: String(err) }));
      }
    }
  }

  // ───────────── Confirmação (backend ↔ provedor) ─────────────

  /** Notificação do provedor: só um gatilho — o pagamento é sempre reconsultado no provedor. */
  async handleNotification(paymentId: string): Promise<void> {
    const payment = await this.provider.getPayment(paymentId);
    if (!payment) return;
    await this.settle(payment, 'webhook');
  }

  async reconcile(billingPaymentId: string): Promise<void> {
    const payments = await this.provider.findPaymentsByReference(billingPaymentId);
    // Aprovados primeiro: um pagamento recusado seguido de um aprovado libera a compra.
    const ordered = [...payments].sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved'));
    for (const p of ordered) await this.settle(p, 'reconcile');
  }

  /** Aplica o estado de um pagamento do provedor. Idempotente e serializado por cobrança. */
  async apply(p: ProviderPayment, source: 'webhook' | 'reconcile' | 'card'): Promise<void> {
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
            pixQrCode: null,
            pixQrCodeBase64: null,
            pixExpiresAt: null,
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
