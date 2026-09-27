/**
 * Contratação de planos com provedor de pagamento SIMULADO (substitui o Mercado Pago).
 * Requer a mesma infraestrutura dos demais testes de integração (PostgreSQL, Redis).
 */
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { getConfig } from '../../src/config/config';
import { PrismaService } from '../../src/infra/prisma/prisma.service';
import { BILLING_PROVIDER, type BillingProvider, type CheckoutRequest, type ProviderPayment } from '../../src/modules/billing/billing-provider';

const config = getConfig();
const ORIGIN = config.APP_PUBLIC_URL;
const run = Date.now().toString(36);

class FakeProvider implements BillingProvider {
  readonly name = 'mercadopago';
  readonly available = true;
  readonly checkouts: CheckoutRequest[] = [];
  readonly payments = new Map<string, ProviderPayment>();
  createCheckout(req: CheckoutRequest) {
    this.checkouts.push(req);
    return Promise.resolve({ checkoutId: `pref-${req.reference}`, url: `https://pagamento.exemplo.test/checkout/${req.reference}` });
  }
  getPayment(id: string) {
    return Promise.resolve(this.payments.get(id) ?? null);
  }
  findPaymentsByReference(ref: string) {
    return Promise.resolve([...this.payments.values()].filter((p) => p.externalReference === ref));
  }
  verifyWebhook(_h: unknown, dataId: string) {
    return dataId === '999999' ? ('invalid' as const) : ('unsigned' as const);
  }
  pay(id: string, ref: string, status: string, amountCents: number) {
    this.payments.set(id, {
      id,
      status,
      statusDetail: null,
      externalReference: ref,
      amountCents,
      currency: 'BRL',
      paymentType: 'bank_transfer',
      paymentMethod: 'pix',
      installments: 1,
      approvedAt: status === 'approved' ? new Date() : null,
      liveMode: false,
    });
  }
}

describe('Contratação de plano (provedor simulado)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const fake = new FakeProvider();
  let agent: ReturnType<typeof request.agent>;
  const planCode = `PAGO_${run.toUpperCase()}`.slice(0, 30);
  const price = 4990;
  const packCode = `EXTRA_${run.toUpperCase()}`.slice(0, 30);
  const webhook = (id: string) =>
    request(app.getHttpServer()).post(`/api/v1/billing/webhooks/mercadopago?data.id=${id}&type=payment`).send({ type: 'payment', data: { id } });
  const current = async () => (await agent.get('/api/v1/billing').expect(200)).body.current as { code: string; periodEnd: string | null };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(BILLING_PROVIDER).useValue(fake).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app, config);
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.plan.upsert({
      where: { code: config.DEFAULT_PLAN_CODE },
      create: { code: config.DEFAULT_PLAN_CODE, name: 'Teste', monthlyEnvelopes: 5, monthlyDocuments: 5 },
      update: {},
    });
    await prisma.plan.create({
      data: { code: planCode, name: 'Pago teste', monthlyEnvelopes: 2, monthlyDocuments: null, overageBonusPercent: 10, priceCents: price, currency: 'BRL' },
    });
    await prisma.creditPack.create({ data: { code: packCode, name: '3 extras', documents: 3, priceCents: 900 } });
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/register')
      .set('Origin', ORIGIN)
      .send({ organizationName: `Empresa pagante ${run}`, name: 'Dona', email: `pagante-${run}@exemplo.test`, password: 'senha-de-teste-forte-123' })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('contrata pelo backend: só a URL de pagamento vai ao navegador e o plano é liberado após consultar o provedor', async () => {
    const overview = (await agent.get('/api/v1/billing').expect(200)).body;
    expect(overview.onlinePayment).toBe(true);
    expect(overview.plans.find((p: { code: string }) => p.code === planCode)).toMatchObject({ purchasable: true, priceCents: price });
    expect(overview.plans.find((p: { code: string }) => p.code === config.DEFAULT_PLAN_CODE)?.purchasable).toBe(false);

    const res = await agent.post('/api/v1/billing/checkout').set('Origin', ORIGIN).send({ planCode }).expect(201);
    expect(Object.keys(res.body).sort()).toEqual(['paymentId', 'url']);
    expect(res.body.url).toMatch(/^https:\/\/pagamento\.exemplo\.test\//);
    expect(fake.checkouts.at(-1)).toMatchObject({ reference: res.body.paymentId, amountCents: price, currency: 'BRL' });
    expect(fake.checkouts.at(-1)!.notificationUrl).toMatch(/\/api\/v1\/billing\/webhooks\/mercadopago$/);
    // O navegador não define valor: campos extras são recusados; plano gratuito não é contratável.
    await agent.post('/api/v1/billing/checkout').set('Origin', ORIGIN).send({ planCode, amountCents: 1 }).expect(400);
    await agent.post('/api/v1/billing/checkout').set('Origin', ORIGIN).send({ planCode: config.DEFAULT_PLAN_CODE }).expect(404);

    const ref = res.body.paymentId as string;
    expect((await agent.get(`/api/v1/billing/payments/${ref}`).expect(200)).body.status).toBe('PENDING');

    // Valor divergente: não libera.
    fake.pay('100001', ref, 'approved', 100);
    await webhook('100001').expect(200);
    expect((await current()).code).toBe(config.DEFAULT_PLAN_CODE);

    // Assinatura inválida: recusada.
    await webhook('999999').expect(401);

    // Aprovado e correto: libera por 1 mês; notificação repetida não estende de novo.
    fake.payments.delete('100001');
    fake.pay('100002', ref, 'approved', price);
    await webhook('100002').expect(200);
    const after = await current();
    expect(after.code).toBe(planCode);
    const end1 = new Date(after.periodEnd!).getTime();
    expect(end1 - Date.now()).toBeGreaterThan(27 * 86400_000);
    await webhook('100002').expect(200);
    expect(new Date((await current()).periodEnd!).getTime()).toBe(end1);
    const history = (await agent.get('/api/v1/billing/payments').expect(200)).body.data;
    expect(history[0]).toMatchObject({ id: ref, status: 'APPROVED', paymentType: 'bank_transfer' });
    expect(JSON.stringify(history)).not.toMatch(/100002|pref-/);

    // Renovação do mesmo plano soma ao período — confirmada pela reconsulta, sem webhook.
    const renew = await agent.post('/api/v1/billing/checkout').set('Origin', ORIGIN).send({ planCode }).expect(201);
    fake.pay('100003', renew.body.paymentId, 'approved', price);
    expect((await agent.get(`/api/v1/billing/payments/${renew.body.paymentId}`).expect(200)).body.status).toBe('APPROVED');
    const end2 = new Date((await current()).periodEnd!).getTime();
    expect(end2 - end1).toBeGreaterThan(27 * 86400_000);

    // Estorno do pagamento vigente: volta ao plano padrão.
    fake.pay('100003', renew.body.paymentId, 'refunded', price);
    await webhook('100003').expect(200);
    expect((await current()).code).toBe(config.DEFAULT_PLAN_CODE);
  });

  it('cota: plano + bônus de 10% e depois documentos extras (só para plano pago)', async () => {
    const newEnvelope = () => agent.post('/api/v1/envelopes').set('Origin', ORIGIN).send({ title: `Env ${Math.random()}` });
    // Após o estorno do teste anterior a conta está no plano gratuito: não compra extras.
    await agent.post('/api/v1/billing/checkout').set('Origin', ORIGIN).send({ packCode }).expect(422);
    await agent.post('/api/v1/billing/checkout').set('Origin', ORIGIN).send({ planCode, packCode }).expect(400);

    const buy = await agent.post('/api/v1/billing/checkout').set('Origin', ORIGIN).send({ planCode }).expect(201);
    fake.pay('200001', buy.body.paymentId, 'approved', price);
    await webhook('200001').expect(200);
    // Zera o uso do mês para medir a cota de forma determinística.
    const orgId = (await agent.get('/api/v1/organizations/current').expect(200)).body.id as string;
    await prisma.usageRecord.deleteMany({ where: { organizationId: orgId, metric: 'ENVELOPES_CREATED' } });

    // Plano: 2; bônus: 10% de 2 = 1 (arredondado para cima) → 3 envelopes.
    for (let i = 0; i < 3; i++) await newEnvelope().expect(201);
    const blocked = await newEnvelope().expect(402);
    expect(blocked.body.error.details).toMatchObject({ limit: 2, bonus: 1, can_buy_extra: true, extra_credits: 0 });

    const pack = await agent.post('/api/v1/billing/checkout').set('Origin', ORIGIN).send({ packCode }).expect(201);
    fake.pay('200002', pack.body.paymentId, 'approved', 900);
    await webhook('200002').expect(200);
    expect((await agent.get('/api/v1/billing').expect(200)).body.quota).toMatchObject({ limit: 2, bonus: 1, used: 3, credits: 3, next: 'credit' });
    await newEnvelope().expect(201);
    expect((await agent.get('/api/v1/billing').expect(200)).body.quota.credits).toBe(2);

    // Estorno do pacote retira só o saldo restante.
    fake.pay('200002', pack.body.paymentId, 'refunded', 900);
    await webhook('200002').expect(200);
    expect((await agent.get('/api/v1/billing').expect(200)).body.quota.credits).toBe(0);
    await newEnvelope().expect(402);
  });

  it('notificação de pagamento desconhecido ou de outro tipo é ignorada sem erro', async () => {
    await webhook('123456789').expect(200);
    await request(app.getHttpServer()).post('/api/v1/billing/webhooks/mercadopago?type=merchant_order&data.id=5').send({}).expect(200);
  });
});
