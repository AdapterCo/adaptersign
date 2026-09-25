import { Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { configureAuthMethods } from '../../modules/signing/auth-methods';

export interface WhatsAppSendResult {
  messageId: string | null;
}

/** Envio de mensagens de texto pelo número central da plataforma. */
export interface WhatsAppProvider {
  readonly enabled: boolean;
  /** `to` em E.164 ("+5524999999999"). */
  sendText(to: string, text: string): Promise<WhatsAppSendResult>;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');

export class WhatsAppSendError extends Error {
  override name = 'WhatsAppSendError';
  constructor(
    message: string,
    /** Erro definitivo (ex.: número sem WhatsApp) — não adianta tentar de novo. */
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** WhatsApp desabilitado (WHATSAPP_PROVIDER=none). */
export class DisabledWhatsAppProvider implements WhatsAppProvider {
  readonly enabled = false;
  sendText(): Promise<WhatsAppSendResult> {
    return Promise.reject(new WhatsAppSendError('WhatsApp não configurado.', true));
  }
}

/**
 * Evolution API v2: POST {url}/message/sendText/{instance} com cabeçalho `apikey`
 * e corpo { number, text }. A chave nunca é registrada em log.
 */
export class EvolutionWhatsAppProvider implements WhatsAppProvider {
  readonly enabled = true;
  private readonly logger = new Logger('WhatsApp');

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly instance: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText(to: string, text: string): Promise<WhatsAppSendResult> {
    const number = to.replace(/\D/g, '');
    const url = `${this.baseUrl.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(this.instance)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
        body: JSON.stringify({ number, text }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new WhatsAppSendError(`Falha de conexão com a Evolution API: ${err instanceof Error ? err.message : String(err)}`, false);
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      // 400/404: número inexistente no WhatsApp ou instância inválida — não adianta repetir.
      const permanent = res.status === 400 || res.status === 404;
      this.logger.warn({ event: 'whatsapp_send_failed', status: res.status });
      throw new WhatsAppSendError(`Evolution API respondeu HTTP ${res.status}: ${raw.slice(0, 300)}`, permanent);
    }
    let messageId: string | null = null;
    try {
      const body = JSON.parse(raw) as { key?: { id?: unknown } };
      messageId = typeof body.key?.id === 'string' ? body.key.id : null;
    } catch {
      /* resposta sem JSON */
    }
    return { messageId };
  }
}

export const whatsappProvider = {
  provide: WHATSAPP_PROVIDER,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): WhatsAppProvider => {
    const provider =
      config.WHATSAPP_PROVIDER === 'evolution'
        ? new EvolutionWhatsAppProvider(config.EVOLUTION_API_URL!, config.EVOLUTION_API_KEY!, config.EVOLUTION_INSTANCE!, config.WHATSAPP_TIMEOUT_MS)
        : new DisabledWhatsAppProvider();
    // WHATSAPP_OTP só aparece como disponível com integração real configurada.
    configureAuthMethods({ whatsapp: provider.enabled });
    return provider;
  },
};

