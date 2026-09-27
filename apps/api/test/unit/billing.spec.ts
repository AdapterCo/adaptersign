import { createHmac } from 'node:crypto';
import { addMonths, envelopeQuota, mapProviderStatus, nextPeriod } from '../../src/modules/billing/billing-period';
import { MercadoPagoBillingProvider } from '../../src/modules/billing/billing-provider';

describe('períodos de plano', () => {
  it('soma meses de calendário sem pular mês', () => {
    expect(addMonths(new Date('2026-01-31T12:00:00Z'), 1).toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(addMonths(new Date('2026-03-15T00:00:00Z'), 1).toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(addMonths(new Date('2026-12-10T00:00:00Z'), 1).toISOString()).toBe('2027-01-10T00:00:00.000Z');
  });

  it('renovação do mesmo plano vigente soma ao fim; troca de plano começa agora', () => {
    const now = new Date('2026-09-27T00:00:00Z');
    const end = new Date('2026-10-10T00:00:00Z');
    const current = { planId: 'pro', status: 'ACTIVE', currentPeriodEnd: end };
    expect(nextPeriod(current, 'pro', 1, now)).toEqual({ start: end, end: new Date('2026-11-10T00:00:00Z'), extended: true });
    expect(nextPeriod(current, 'business', 1, now)).toMatchObject({ start: now, extended: false });
    expect(nextPeriod({ ...current, currentPeriodEnd: new Date('2026-09-01T00:00:00Z') }, 'pro', 1, now)).toMatchObject({ start: now, extended: false });
    expect(nextPeriod(null, 'pro', 1, now).end.toISOString()).toBe('2026-10-27T00:00:00.000Z');
  });

  it('mapeia status do Mercado Pago', () => {
    expect(mapProviderStatus('approved')).toBe('APPROVED');
    expect(mapProviderStatus('in_process')).toBe('IN_PROCESS');
    expect(mapProviderStatus('charged_back')).toBe('REFUNDED');
    expect(mapProviderStatus('qualquer')).toBeNull();
  });
});

describe('cota de documentos (plano → bônus de 10% → extras)', () => {
  const plan = { monthlyEnvelopes: 50, overageBonusPercent: 10 };

  it('usa o plano, depois o bônus e por fim os extras comprados', () => {
    expect(envelopeQuota(plan, 0, 0)).toEqual({ limit: 50, bonus: 5, used: 0, credits: 0, next: 'plan' });
    expect(envelopeQuota(plan, 49, 0).next).toBe('plan');
    expect(envelopeQuota(plan, 50, 0).next).toBe('bonus');
    expect(envelopeQuota(plan, 54, 0).next).toBe('bonus');
    expect(envelopeQuota(plan, 55, 3).next).toBe('credit');
    expect(envelopeQuota(plan, 55, 0).next).toBeNull();
  });

  it('bônus é 10% do contratado (100 → 10; 200 → 20), arredondado para cima', () => {
    expect(envelopeQuota({ monthlyEnvelopes: 100, overageBonusPercent: 10 }, 0, 0).bonus).toBe(10);
    expect(envelopeQuota({ monthlyEnvelopes: 200, overageBonusPercent: 10 }, 0, 0).bonus).toBe(20);
    expect(envelopeQuota({ monthlyEnvelopes: 5, overageBonusPercent: 10 }, 0, 0).bonus).toBe(1);
    expect(envelopeQuota({ monthlyEnvelopes: 5, overageBonusPercent: 0 }, 5, 0).next).toBeNull();
  });

  it('plano ilimitado', () => {
    expect(envelopeQuota({ monthlyEnvelopes: null, overageBonusPercent: 10 }, 999, 0).next).toBe('unlimited');
  });
});

describe('MercadoPagoBillingProvider (Checkout Transparente)', () => {
  const TOKEN = 'APP_USR-token-secreto-de-teste-000000';
  const PUBLIC = 'APP_USR-chave-publica-de-teste-0000';
  function fakeFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }
  const opts = { apiUrl: 'https://api.exemplo.test', statementDescriptor: 'ADAPTERSIGN', timeoutMs: 5000 };
  const base = {
    reference: '0192f0a0-0000-7000-8000-000000000001',
    description: 'Plano Pro',
    amountCents: 4990,
    notificationUrl: 'https://app.exemplo.test/api/v1/billing/webhooks/mercadopago',
    idempotencyKey: 'chave-1',
  };
  const provider = (fn: typeof fetch, secret: string | null = null) => new MercadoPagoBillingProvider(TOKEN, PUBLIC, secret, opts, fn);

  it('Pix: cria o pagamento no backend e devolve o QR Code', async () => {
    const { fn, calls } = fakeFetch(201, {
      id: 555,
      status: 'pending',
      external_reference: base.reference,
      transaction_amount: 49.9,
      currency_id: 'BRL',
      payment_type_id: 'bank_transfer',
      payment_method_id: 'pix',
      date_of_expiration: '2026-09-27T12:30:00.000Z',
      point_of_interaction: { transaction_data: { qr_code: '00020126...', qr_code_base64: 'iVBORw0KGgo=' } },
    });
    const pay = await provider(fn).createPixPayment({ ...base, payerEmail: 'dono@exemplo.test', expiresAt: new Date('2026-09-27T12:30:00Z') });
    expect(pay).toMatchObject({ id: '555', status: 'pending', amountCents: 4990, pix: { qrCode: '00020126...', qrCodeBase64: 'iVBORw0KGgo=' } });
    expect(calls[0].url).toBe('https://api.exemplo.test/v1/payments');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['X-Idempotency-Key']).toBe('chave-1');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ transaction_amount: 49.9, payment_method_id: 'pix', external_reference: base.reference });
  });

  it('Cartão: valor do servidor e sempre 1 parcela', async () => {
    const { fn, calls } = fakeFetch(201, { id: 777, status: 'approved', external_reference: base.reference, transaction_amount: 49.9, currency_id: 'BRL', installments: 1 });
    const p = provider(fn);
    const pay = await p.createCardPayment({
      ...base,
      token: 'abcdef0123456789abcdef0123456789',
      paymentMethodId: 'master',
      issuerId: '24',
      payer: { email: 'titular@exemplo.test', identification: { type: 'CPF', number: '52998224725' } },
    });
    expect(pay.status).toBe('approved');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ transaction_amount: 49.9, installments: 1, token: 'abcdef0123456789abcdef0123456789', payment_method_id: 'master', issuer_id: 24 });
    expect(p.publicKey).toBe(PUBLIC);
  });

  it('erro do provedor não expõe a credencial', async () => {
    const err = await provider(fakeFetch(400, { message: 'invalid token' }).fn)
      .createCardPayment({ ...base, token: 'x'.repeat(32), paymentMethodId: 'visa', issuerId: null, payer: { email: 'a@b.test', identification: null } })
      .catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect((err as { code?: string }).code).toBe('PAYMENT_NOT_CREATED');
  });

  it('estorno usa chave de idempotência por pagamento', async () => {
    const { fn, calls } = fakeFetch(201, { id: 1 });
    await provider(fn).refundPayment('555');
    expect(calls[0].url).toBe('https://api.exemplo.test/v1/payments/555/refunds');
    expect((calls[0].init.headers as Record<string, string>)['X-Idempotency-Key']).toBe('refund-555');
  });

  it('consulta pagamento e ignora ids inválidos', async () => {
    const p = provider(fakeFetch(200, { id: 123, status: 'approved', external_reference: 'ref', transaction_amount: 49.9, currency_id: 'BRL', payment_type_id: 'credit_card' }).fn);
    await expect(p.getPayment('123')).resolves.toMatchObject({ id: '123', status: 'approved', amountCents: 4990, pix: null });
    await expect(p.getPayment('../x')).resolves.toBeNull();
  });

  it('valida x-signature (HMAC-SHA256 do manifesto)', () => {
    const secret = 'segredo-webhook-123456';
    const p = provider(fakeFetch(200, {}).fn, secret);
    const ts = '1727400000';
    const v1 = createHmac('sha256', secret).update(`id:123;request-id:req-1;ts:${ts};`).digest('hex');
    expect(p.verifyWebhook({ 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-1' }, '123')).toBe('valid');
    expect(p.verifyWebhook({ 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-2' }, '123')).toBe('invalid');
    expect(p.verifyWebhook({ 'x-signature': `ts=${ts},v1=${'0'.repeat(64)}` }, '123')).toBe('invalid');
    expect(p.verifyWebhook({}, '123')).toBe('unsigned');
  });
});
