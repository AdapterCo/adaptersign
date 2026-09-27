import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Errors } from '../../common/errors/app-error';

export interface CheckoutRequest {
  /** Nosso id do pagamento — enviado como external_reference e usado como chave de idempotência. */
  reference: string;
  title: string;
  amountCents: number;
  currency: string;
  payerEmail: string;
  /** Página do app para onde o cliente volta (o status real é sempre consultado no backend). */
  returnUrl: string;
  notificationUrl: string;
  expiresAt: Date;
}

/** Pagamento como informado pelo PROVEDOR (consultado pelo backend, nunca recebido do navegador). */
export interface ProviderPayment {
  id: string;
  status: string;
  statusDetail: string | null;
  externalReference: string | null;
  amountCents: number;
  currency: string;
  paymentType: string | null;
  paymentMethod: string | null;
  installments: number | null;
  approvedAt: Date | null;
  liveMode: boolean | null;
}

export type WebhookCheck = 'valid' | 'invalid' | 'unsigned';

/**
 * Provedor de pagamento. Todas as chamadas partem do backend; nenhuma credencial vai ao navegador.
 * Regras de negócio (planos, períodos, limites) não dependem do provedor.
 */
export interface BillingProvider {
  readonly name: string;
  readonly available: boolean;
  createCheckout(req: CheckoutRequest): Promise<{ checkoutId: string; url: string }>;
  getPayment(paymentId: string): Promise<ProviderPayment | null>;
  findPaymentsByReference(reference: string): Promise<ProviderPayment[]>;
  /** Assinatura da notificação (quando o provedor a envia). */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, dataId: string): WebhookCheck;
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/** Sem provedor configurado: contratação online indisponível (planos atribuídos no painel admin). */
export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';
  readonly available = false;

  createCheckout(): Promise<{ checkoutId: string; url: string }> {
    return Promise.reject(Errors.unavailable('BILLING_PROVIDER_NOT_CONFIGURED', 'Pagamento online ainda não está disponível. Contate o suporte.'));
  }
  getPayment(): Promise<ProviderPayment | null> {
    return Promise.resolve(null);
  }
  findPaymentsByReference(): Promise<ProviderPayment[]> {
    return Promise.resolve([]);
  }
  verifyWebhook(): WebhookCheck {
    return 'invalid';
  }
}

const toCents = (v: unknown): number => Math.round(Number(v) * 100);
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Mercado Pago — Checkout Pro (página de pagamento hospedada pelo Mercado Pago).
 * O cartão é digitado apenas na página do Mercado Pago; o backend só usa o Access Token
 * (nunca registrado em log nem devolvido ao cliente). Pix e cartão à vista (1 parcela).
 */
export class MercadoPagoBillingProvider implements BillingProvider {
  readonly name = 'mercadopago';
  readonly available = true;
  private readonly logger = new Logger('MercadoPago');

  constructor(
    private readonly accessToken: string,
    private readonly webhookSecret: string | null,
    private readonly opts: { apiUrl: string; statementDescriptor: string; useSandboxUrl: boolean; timeoutMs: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.apiUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      this.logger.warn({ event: 'mercadopago_unreachable', path: path.split('?')[0], error: err instanceof Error ? err.message : String(err) });
      throw Errors.unavailable('PAYMENT_PROVIDER_UNAVAILABLE', 'Não foi possível contatar o Mercado Pago. Tente novamente em instantes.');
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 500 || res.status === 429) {
      this.logger.warn({ event: 'mercadopago_error', status: res.status, path: path.split('?')[0] });
      throw Errors.unavailable('PAYMENT_PROVIDER_UNAVAILABLE', 'O Mercado Pago está indisponível no momento. Tente novamente em instantes.');
    }
    return { status: res.status, json };
  }

  async createCheckout(req: CheckoutRequest): Promise<{ checkoutId: string; url: string }> {
    const body = {
      items: [{ id: req.reference, title: req.title, quantity: 1, unit_price: req.amountCents / 100, currency_id: req.currency }],
      payer: { email: req.payerEmail },
      external_reference: req.reference,
      notification_url: req.notificationUrl,
      back_urls: { success: req.returnUrl, pending: req.returnUrl, failure: req.returnUrl },
      auto_return: 'approved',
      statement_descriptor: this.opts.statementDescriptor,
      // Somente Pix e cartão, sempre à vista.
      payment_methods: {
        excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }, { id: 'digital_currency' }],
        installments: 1,
        default_installments: 1,
      },
      expires: true,
      expiration_date_to: req.expiresAt.toISOString(),
    };
    const { status, json } = await this.call('POST', '/checkout/preferences', body, `pref-${req.reference}`);
    const r = (json ?? {}) as { id?: unknown; init_point?: unknown; sandbox_init_point?: unknown; message?: unknown };
    const url = str(this.opts.useSandboxUrl ? r.sandbox_init_point : r.init_point);
    if (status >= 300 || !r.id || !url) {
      this.logger.warn({ event: 'mercadopago_preference_failed', status, message: str(r.message) });
      throw Errors.unavailable('PAYMENT_PROVIDER_ERROR', 'Não foi possível iniciar o pagamento. Tente novamente ou contate o suporte.');
    }
    return { checkoutId: String(r.id), url };
  }

  private parsePayment(p: Record<string, unknown>): ProviderPayment {
    return {
      id: String(p.id),
      status: String(p.status ?? ''),
      statusDetail: str(p.status_detail),
      externalReference: str(p.external_reference),
      amountCents: toCents(p.transaction_amount),
      currency: String(p.currency_id ?? ''),
      paymentType: str(p.payment_type_id),
      paymentMethod: str(p.payment_method_id),
      installments: typeof p.installments === 'number' ? p.installments : null,
      approvedAt: p.date_approved ? new Date(String(p.date_approved)) : null,
      liveMode: typeof p.live_mode === 'boolean' ? p.live_mode : null,
    };
  }

  async getPayment(paymentId: string): Promise<ProviderPayment | null> {
    if (!/^\d{1,30}$/.test(paymentId)) return null;
    const { status, json } = await this.call('GET', `/v1/payments/${paymentId}`);
    if (status === 404) return null;
    if (status >= 300 || !json) throw Errors.unavailable('PAYMENT_PROVIDER_ERROR', 'Falha ao consultar o pagamento no Mercado Pago.');
    return this.parsePayment(json as Record<string, unknown>);
  }

  async findPaymentsByReference(reference: string): Promise<ProviderPayment[]> {
    const qs = new URLSearchParams({ external_reference: reference, sort: 'date_created', criteria: 'desc', limit: '20' });
    const { status, json } = await this.call('GET', `/v1/payments/search?${qs.toString()}`);
    if (status >= 300) throw Errors.unavailable('PAYMENT_PROVIDER_ERROR', 'Falha ao consultar pagamentos no Mercado Pago.');
    const results = ((json ?? {}) as { results?: unknown[] }).results ?? [];
    return results.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null).map((r) => this.parsePayment(r));
  }

  /**
   * Cabeçalho `x-signature: ts=<ts>,v1=<hmac>`; manifesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
   * (partes ausentes são omitidas; id alfanumérico em minúsculas), HMAC-SHA256 com a chave secreta.
   */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, dataId: string): WebhookCheck {
    const signature = header(headers, 'x-signature');
    if (!signature || !this.webhookSecret) return 'unsigned';
    const parts = Object.fromEntries(
      signature.split(',').map((kv) => {
        const [k, ...v] = kv.split('=');
        return [k.trim(), v.join('=').trim()];
      }),
    );
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return 'invalid';
    const requestId = header(headers, 'x-request-id');
    let manifest = '';
    if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
    if (requestId) manifest += `request-id:${requestId};`;
    manifest += `ts:${ts};`;
    const expected = createHmac('sha256', this.webhookSecret).update(manifest).digest();
    const given = Buffer.from(v1, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected) ? 'valid' : 'invalid';
  }
}

export const billingProvider = {
  provide: BILLING_PROVIDER,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): BillingProvider =>
    config.BILLING_PROVIDER === 'mercadopago'
      ? new MercadoPagoBillingProvider(config.MERCADOPAGO_ACCESS_TOKEN!, config.MERCADOPAGO_WEBHOOK_SECRET ?? null, {
          apiUrl: config.MERCADOPAGO_API_URL,
          statementDescriptor: config.MERCADOPAGO_STATEMENT_DESCRIPTOR,
          useSandboxUrl: config.MERCADOPAGO_USE_SANDBOX_URL,
          timeoutMs: 15000,
        })
      : new ManualBillingProvider(),
};
