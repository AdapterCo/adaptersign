import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Errors } from '../../common/errors/app-error';

interface PaymentBase {
  /** Nosso id da cobrança — enviado como external_reference. */
  reference: string;
  description: string;
  amountCents: number;
  notificationUrl: string;
  /** Chave de idempotência da criação no provedor. */
  idempotencyKey: string;
}

export interface PixRequest extends PaymentBase {
  payerEmail: string;
  expiresAt: Date;
}

export interface CardRequest extends PaymentBase {
  /** Token de uso único gerado pelo componente do provedor no navegador (o cartão nunca chega aqui). */
  token: string;
  paymentMethodId: string;
  issuerId: string | null;
  payer: { email: string; identification: { type: 'CPF' | 'CNPJ'; number: string } | null };
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
  /** Pix: dados para exibir o QR Code (públicos para quem paga). */
  pix: { qrCode: string; qrCodeBase64: string | null; expiresAt: Date | null } | null;
}

export type WebhookCheck = 'valid' | 'invalid' | 'unsigned';

/**
 * Provedor de pagamento (Checkout Transparente). Todas as transações partem do backend com a
 * credencial privada; o navegador só recebe a chave PÚBLICA para tokenizar o cartão.
 */
export interface BillingProvider {
  readonly name: string;
  readonly available: boolean;
  /** Chave pública (Public Key) para o componente de cartão no navegador — não é segredo. */
  readonly publicKey: string | null;
  createPixPayment(req: PixRequest): Promise<ProviderPayment>;
  createCardPayment(req: CardRequest): Promise<ProviderPayment>;
  cancelPayment(paymentId: string): Promise<void>;
  getPayment(paymentId: string): Promise<ProviderPayment | null>;
  findPaymentsByReference(reference: string): Promise<ProviderPayment[]>;
  /** Assinatura da notificação (quando o provedor a envia). */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, dataId: string): WebhookCheck;
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

const unavailable = () => Errors.unavailable('BILLING_PROVIDER_NOT_CONFIGURED', 'Pagamento online ainda não está disponível. Contate o suporte.');

/** Sem provedor configurado: contratação online indisponível (planos atribuídos no painel admin). */
export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';
  readonly available = false;
  readonly publicKey = null;

  createPixPayment(): Promise<ProviderPayment> {
    return Promise.reject(unavailable());
  }
  createCardPayment(): Promise<ProviderPayment> {
    return Promise.reject(unavailable());
  }
  cancelPayment(): Promise<void> {
    return Promise.resolve();
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
 * Mercado Pago — Checkout Transparente (API de pagamentos /v1/payments).
 * Pix: o backend cria o pagamento e devolve o QR Code. Cartão: o backend cria o pagamento com o
 * token gerado no navegador, sempre à vista (1 parcela) e com o valor definido no servidor.
 * O Access Token nunca é registrado em log nem devolvido ao cliente.
 */
export class MercadoPagoBillingProvider implements BillingProvider {
  readonly name = 'mercadopago';
  readonly available = true;
  private readonly logger = new Logger('MercadoPago');

  constructor(
    private readonly accessToken: string,
    readonly publicKey: string,
    private readonly webhookSecret: string | null,
    private readonly opts: { apiUrl: string; statementDescriptor: string; timeoutMs: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; json: unknown }> {
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

  private parsePayment(p: Record<string, unknown>): ProviderPayment {
    const tx = ((p.point_of_interaction as Record<string, unknown> | undefined)?.transaction_data ?? null) as Record<string, unknown> | null;
    const qr = tx ? str(tx.qr_code) : null;
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
      pix: qr ? { qrCode: qr, qrCodeBase64: str(tx!.qr_code_base64), expiresAt: p.date_of_expiration ? new Date(String(p.date_of_expiration)) : null } : null,
    };
  }

  private async createPayment(body: Record<string, unknown>, idempotencyKey: string): Promise<ProviderPayment> {
    const { status, json } = await this.call('POST', '/v1/payments', body, idempotencyKey);
    const r = (json ?? {}) as Record<string, unknown>;
    if (status >= 300 || !r.id) {
      // Dados do cartão/token inválidos etc. — mensagem genérica; detalhe só no log (sem credenciais).
      this.logger.warn({ event: 'mercadopago_payment_failed', status, message: str(r.message), cause: JSON.stringify(r.cause ?? null).slice(0, 300) });
      throw Errors.unprocessable('PAYMENT_NOT_CREATED', 'Não foi possível processar o pagamento. Confira os dados e tente novamente.');
    }
    return this.parsePayment(r);
  }

  createPixPayment(req: PixRequest): Promise<ProviderPayment> {
    return this.createPayment(
      {
        transaction_amount: req.amountCents / 100,
        description: req.description,
        payment_method_id: 'pix',
        payer: { email: req.payerEmail },
        external_reference: req.reference,
        notification_url: req.notificationUrl,
        date_of_expiration: req.expiresAt.toISOString(),
      },
      req.idempotencyKey,
    );
  }

  createCardPayment(req: CardRequest): Promise<ProviderPayment> {
    return this.createPayment(
      {
        transaction_amount: req.amountCents / 100,
        description: req.description,
        token: req.token,
        installments: 1,
        payment_method_id: req.paymentMethodId,
        ...(req.issuerId ? { issuer_id: Number(req.issuerId) } : {}),
        payer: { email: req.payer.email, ...(req.payer.identification ? { identification: req.payer.identification } : {}) },
        external_reference: req.reference,
        notification_url: req.notificationUrl,
        statement_descriptor: this.opts.statementDescriptor,
        binary_mode: false,
      },
      req.idempotencyKey,
    );
  }

  async cancelPayment(paymentId: string): Promise<void> {
    if (!/^\d{1,30}$/.test(paymentId)) return;
    await this.call('PUT', `/v1/payments/${paymentId}`, { status: 'cancelled' });
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
      ? new MercadoPagoBillingProvider(config.MERCADOPAGO_ACCESS_TOKEN!, config.MERCADOPAGO_PUBLIC_KEY!, config.MERCADOPAGO_WEBHOOK_SECRET ?? null, {
          apiUrl: config.MERCADOPAGO_API_URL,
          statementDescriptor: config.MERCADOPAGO_STATEMENT_DESCRIPTOR,
          timeoutMs: 15000,
        })
      : new ManualBillingProvider(),
};
