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

describe('MercadoPagoBillingProvider', () => {
  const TOKEN = 'APP_USR-token-secreto-de-teste-000000';
  function fakeFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }
  const opts = { apiUrl: 'https://api.exemplo.test', statementDescriptor: 'ADAPTERSIGN', useSandboxUrl: false, timeoutMs: 5000 };
  const req = {
    reference: '0192f0a0-0000-7000-8000-000000000001',
    title: 'Plano Pro',
    amountCents: 4990,
    currency: 'BRL',
    payerEmail: 'dono@exemplo.test',
    returnUrl: 'https://app.exemplo.test/billing?payment=x',
    notificationUrl: 'https://app.exemplo.test/api/v1/billing/webhooks/mercadopago',
    expiresAt: new Date('2026-09-28T00:00:00Z'),
  };

  it('cria a preferência só com Pix/cartão à vista e devolve apenas id e URL', async () => {
    const { fn, calls } = fakeFetch(201, {
      id: 'pref-1',
      init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',
      sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',
    });
    const p = new MercadoPagoBillingProvider(TOKEN, 'segredo-webhook-123456', opts, fn);
    await expect(p.createCheckout(req)).resolves.toEqual({ checkoutId: 'pref-1', url: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1' });
    expect(calls[0].url).toBe('https://api.exemplo.test/checkout/preferences');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['X-Idempotency-Key']).toBe(`pref-${req.reference}`);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.items[0]).toMatchObject({ unit_price: 49.9, currency_id: 'BRL', quantity: 1 });
    expect(body.payment_methods).toEqual({
      excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }, { id: 'digital_currency' }],
      installments: 1,
      default_installments: 1,
    });
    expect(body.external_reference).toBe(req.reference);
  });

  it('erro do provedor não expõe a credencial', async () => {
    const p = new MercadoPagoBillingProvider(TOKEN, null, opts, fakeFetch(400, { message: 'invalid' }).fn);
    const err = await p.createCheckout(req).catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it('converte o pagamento consultado', async () => {
    const p = new MercadoPagoBillingProvider(
      TOKEN,
      null,
      opts,
      fakeFetch(200, {
        id: 123,
        status: 'approved',
        external_reference: 'ref',
        transaction_amount: 49.9,
        currency_id: 'BRL',
        payment_type_id: 'credit_card',
        installments: 1,
      }).fn,
    );
    await expect(p.getPayment('123')).resolves.toMatchObject({ id: '123', status: 'approved', amountCents: 4990, currency: 'BRL', installments: 1 });
    await expect(p.getPayment('../x')).resolves.toBeNull();
  });

  it('valida x-signature (HMAC-SHA256 do manifesto)', () => {
    const secret = 'segredo-webhook-123456';
    const p = new MercadoPagoBillingProvider(TOKEN, secret, opts, fakeFetch(200, {}).fn);
    const ts = '1727400000';
    const v1 = createHmac('sha256', secret).update(`id:123;request-id:req-1;ts:${ts};`).digest('hex');
    expect(p.verifyWebhook({ 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-1' }, '123')).toBe('valid');
    expect(p.verifyWebhook({ 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-2' }, '123')).toBe('invalid');
    expect(p.verifyWebhook({ 'x-signature': `ts=${ts},v1=${'0'.repeat(64)}` }, '123')).toBe('invalid');
    expect(p.verifyWebhook({}, '123')).toBe('unsigned');
  });
});
