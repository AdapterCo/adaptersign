/**
 * Contratação de planos (Checkout Transparente) com provedor de pagamento SIMULADO.
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
import {
  BILLING_PROVIDER,
  type BillingProvider,
  type CardRequest,
  type PixRequest,
  type ProviderPayment,
} from '../../src/modules/billing/billing-provider';

const config = getConfig();
const ORIGIN = config.APP_PUBLIC_URL;
const run = Date.now().toString(36);
const CARD_OK = 'a'.repeat(32);
const CARD_REJECT = 'b'.repeat(32);

class FakeProvider implements BillingProvider {
  readonly name = 'mercadopago';
  readonly available = true;
  readonly publicKey = 'TEST-chave-publica-simulada';
  readonly payments = new Map<string, ProviderPayment>();
  readonly cardRequests: CardRequest[] = [];
  readonly cancelled: string[] = [];
  private seq = 900000;

  private make(ref: string, status: string, amountCents: number, type: string, pix = false): ProviderPayment {
    const p: ProviderPayment = {
      id: String(++this.seq),
      status,
      statusDetail: status === 'rejected' ? 'cc_rejected_insufficient_amount' : null,
      externalReference: ref,
      amountCents,
      currency: 'BRL',
      paymentType: type,
      paymentMethod: pix ? 'pix' : 'master',
      installments: 1,
      approvedAt: status === 'approved' ? new Date() : null,
      liveMode: false,
      pix: pix ? { qrCode: `00020126pix-${ref}`, qrCodeBase64: 'iVBORw0KGgo=', expiresAt: new Date(Date.now() + 30 * 60_000) } : null,
    };
    this.payments.set(p.id, p);
    return p;
  }
  createPixPayment(req: PixRequest) {
    return Promise.resolve(this.make(req.reference, 'pending', req.amountCents, 'bank_transfer', true));
  }
  createCardPayment(req: CardRequest) {
    this.cardRequests.push(req);
    return Promise.resolve(this.make(req.reference, req.token === CARD_REJECT ? 'rejected' : 'approved', req.amountCents, 'credit_card'));
  }
  cancelPayment(id: string) {
    this.cancelled.push(id);
    const p = this.payments.get(id);
    if (p) this.payments.set(id, { ...p, status: 'cancelled' });
    return Promise.resolve();
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
  /** Simula o banco confirmando (ou alterando) um pagamento existente. */
  set(id: string, patch: Partial<ProviderPayment>) {
    this.payments.set(id, { ...this.payments.get(id)!, ...patch });
  }
}

describe('Contratação de plano — Checkout Transparente (provedor simulado)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const fake = new FakeProvider();
  let agent: ReturnType<typeof request.agent>;
  const planCode = `PAGO_${run.toUpperCase()}`.slice(0, 30);
  const packCode = `EXTRA_${run.toUpperCase()}`.slice(0, 30);
  const price = 4990;
  const post = (url: string) => agent.post(url).set('Origin', ORIGIN);
  const webhook = (id: string) =>
    request(app.getHttpServer()).post(`/api/v1/billing/webhooks/mercadopago?data.id=${id}&type=payment`).send({ type: 'payment', data: { id } });
  const current = async () => (await agent.get('/api/v1/billing').expect(200)).body.current as { code: string; periodEnd: string | null };
  const order = async (body: object) => (await post('/api/v1/billing/checkout').send(body).expect(201)).body.paymentId as string;

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
    await post('/api/v1/auth/register')
      .send({ organizationName: `Empresa pagante ${run}`, name: 'Dona', email: `pagante-${run}@exemplo.test`, password: 'senha-de-teste-forte-123' })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Pix na própria página: pedido com valor do servidor, QR Code e liberação só após o provedor confirmar', async () => {
    const overview = (await agent.get('/api/v1/billing').expect(200)).body;
    expect(overview).toMatchObject({ onlinePayment: true, publicKey: 'TEST-chave-publica-simulada' });
    expect(overview.plans.find((p: { code: string }) => p.code === planCode)).toMatchObject({ purchasable: true, priceCents: price });

    // O navegador não define valor: campos extras são recusados; plano gratuito não é contratável.
    await post('/api/v1/billing/checkout').send({ planCode, amountCents: 1 }).expect(400);
    await post('/api/v1/billing/checkout').send({ planCode: config.DEFAULT_PLAN_CODE }).expect(404);

    const created = await post('/api/v1/billing/checkout').send({ planCode }).expect(201);
    expect(created.body).toMatchObject({ amountCents: price, currency: 'BRL' });
    const ref = created.body.paymentId as string;

    const pix = (await post(`/api/v1/billing/payments/${ref}/pix`).expect(200)).body;
    expect(pix).toMatchObject({ status: 'PENDING', payable: true, pix: { qrCode: `00020126pix-${ref}` } });
    // Gerar de novo reaproveita o mesmo Pix enquanto válido.
    expect((await post(`/api/v1/billing/payments/${ref}/pix`).expect(200)).body.pix.qrCode).toBe(pix.pix.qrCode);
    const pixId = [...fake.payments.values()].find((p) => p.externalReference === ref)!.id;

    // Valor divergente: não libera. Assinatura inválida: recusada.
    fake.set(pixId, { status: 'approved', amountCents: 100 });
    await webhook(pixId).expect(200);
    expect((await current()).code).toBe(config.DEFAULT_PLAN_CODE);
    await webhook('999999').expect(401);

    // Pago corretamente: libera por 1 mês; notificação repetida não estende de novo.
    fake.set(pixId, { status: 'approved', amountCents: price, approvedAt: new Date() });
    await webhook(pixId).expect(200);
    const after = await current();
    expect(after.code).toBe(planCode);
    const end1 = new Date(after.periodEnd!).getTime();
    expect(end1 - Date.now()).toBeGreaterThan(27 * 86400_000);
    await webhook(pixId).expect(200);
    expect(new Date((await current()).periodEnd!).getTime()).toBe(end1);
    const paid = (await agent.get(`/api/v1/billing/payments/${ref}`).expect(200)).body;
    expect(paid).toMatchObject({ status: 'APPROVED', payable: false, pix: null });
    await post(`/api/v1/billing/payments/${ref}/pix`).expect(409);
    expect(JSON.stringify(paid)).not.toMatch(new RegExp(pixId));
  });

  it('Cartão na própria página: só o token vai ao backend; recusado permite nova tentativa; aprovado cancela o Pix pendente', async () => {
    const ref = await order({ planCode });
    await post(`/api/v1/billing/payments/${ref}/pix`).expect(200);
    const pendingPix = [...fake.payments.values()].find((p) => p.externalReference === ref)!.id;

    // Valor/parcelas do navegador são recusados.
    await post(`/api/v1/billing/payments/${ref}/card`).send({ token: CARD_OK, paymentMethodId: 'master', transaction_amount: 0.01 }).expect(400);
    await post(`/api/v1/billing/payments/${ref}/card`).send({ token: CARD_OK, paymentMethodId: 'master', installments: 12 }).expect(400);

    const rejected = (await post(`/api/v1/billing/payments/${ref}/card`).send({ token: CARD_REJECT, paymentMethodId: 'master' }).expect(200)).body;
    expect(rejected).toMatchObject({ status: 'REJECTED', statusDetail: 'cc_rejected_insufficient_amount', payable: true });

    const before = new Date((await current()).periodEnd!).getTime();
    const ok = (
      await post(`/api/v1/billing/payments/${ref}/card`)
        .send({ token: CARD_OK, paymentMethodId: 'master', issuerId: '24', identificationType: 'CPF', identificationNumber: '529.982.247-25' })
        .expect(200)
    ).body;
    expect(ok).toMatchObject({ status: 'APPROVED', paymentType: 'credit_card' });
    expect(fake.cardRequests.at(-1)).toMatchObject({ amountCents: price, payer: { identification: { type: 'CPF', number: '52998224725' } } });
    expect(fake.cancelled).toContain(pendingPix);
    // Renovação do mesmo plano soma ao período.
    expect(new Date((await current()).periodEnd!).getTime() - before).toBeGreaterThan(27 * 86400_000);

    // Estorno do pagamento vigente: volta ao plano padrão.
    const cardId = [...fake.payments.values()].find((p) => p.externalReference === ref && p.status === 'approved')!.id;
    fake.set(cardId, { status: 'refunded' });
    await webhook(cardId).expect(200);
    expect((await current()).code).toBe(config.DEFAULT_PLAN_CODE);
  });

  it('cota: plano + bônus de 10% e depois documentos extras (só para plano pago)', async () => {
    const newEnvelope = () => post('/api/v1/envelopes').send({ title: `Env ${Math.random()}` });
    // Após o estorno a conta está no plano gratuito: não compra extras.
    await post('/api/v1/billing/checkout').send({ packCode }).expect(422);
    await post('/api/v1/billing/checkout').send({ planCode, packCode }).expect(400);

    const buy = await order({ planCode });
    await post(`/api/v1/billing/payments/${buy}/card`).send({ token: CARD_OK, paymentMethodId: 'master' }).expect(200);
    const orgId = (await agent.get('/api/v1/organizations/current').expect(200)).body.id as string;
    await prisma.usageRecord.deleteMany({ where: { organizationId: orgId, metric: 'ENVELOPES_CREATED' } });

    // Plano: 2; bônus: 10% de 2 = 1 (arredondado para cima) → 3 envelopes.
    for (let i = 0; i < 3; i++) await newEnvelope().expect(201);
    const blocked = await newEnvelope().expect(402);
    expect(blocked.body.error.details).toMatchObject({ limit: 2, bonus: 1, can_buy_extra: true, extra_credits: 0 });

    const pack = await order({ packCode });
    await post(`/api/v1/billing/payments/${pack}/card`).send({ token: CARD_OK, paymentMethodId: 'master' }).expect(200);
    expect((await agent.get('/api/v1/billing').expect(200)).body.quota).toMatchObject({ limit: 2, bonus: 1, used: 3, credits: 3, next: 'credit' });
    await newEnvelope().expect(201);
    expect((await agent.get('/api/v1/billing').expect(200)).body.quota.credits).toBe(2);

    // Estorno do pacote retira só o saldo restante.
    const packPay = [...fake.payments.values()].find((p) => p.externalReference === pack && p.status === 'approved')!.id;
    fake.set(packPay, { status: 'refunded' });
    await webhook(packPay).expect(200);
    expect((await agent.get('/api/v1/billing').expect(200)).body.quota.credits).toBe(0);
    await newEnvelope().expect(402);
  });

  it('notificação de pagamento desconhecido ou de outro tipo é ignorada sem erro', async () => {
    await webhook('123456789').expect(200);
    await request(app.getHttpServer()).post('/api/v1/billing/webhooks/mercadopago?type=merchant_order&data.id=5').send({}).expect(200);
  });
});
