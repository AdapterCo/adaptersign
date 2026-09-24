import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';

export interface CheckoutRequest {
  organizationId: string;
  planCode: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export type BillingEvent =
  | { type: 'subscription.activated'; organizationId: string; planCode: string; providerReference: string; periodEnd: Date | null }
  | { type: 'subscription.past_due'; organizationId: string; providerReference: string }
  | { type: 'subscription.cancelled'; organizationId: string; providerReference: string };

/**
 * Camada de cobrança desacoplada. Integrações (Mercado Pago, Stripe, ...) implementam
 * esta interface seguindo a documentação oficial vigente — regras de negócio (planos,
 * limites, assinatura) NÃO dependem do SDK de pagamento.
 */
export interface BillingProvider {
  readonly name: string;
  readonly available: boolean;
  createCheckout(req: CheckoutRequest): Promise<{ url: string }>;
  cancelSubscription(providerReference: string): Promise<void>;
  /** Valida assinatura do webhook do provedor e converte para evento interno. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<BillingEvent | null>;
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/**
 * Provedor "manual": planos atribuídos pelo painel administrativo da plataforma.
 * Checkout online NÃO está implementado e é reportado explicitamente como indisponível.
 */
@Injectable()
export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';
  readonly available = false;

  async createCheckout(): Promise<{ url: string }> {
    throw Errors.unavailable('BILLING_PROVIDER_NOT_CONFIGURED', 'Pagamento online ainda não está disponível. Contate o suporte.');
  }

  async cancelSubscription(): Promise<void> {
    throw Errors.unavailable('BILLING_PROVIDER_NOT_CONFIGURED', 'Pagamento online ainda não está disponível.');
  }

  async parseWebhook(): Promise<BillingEvent | null> {
    throw Errors.unavailable('BILLING_PROVIDER_NOT_CONFIGURED', 'Nenhum provedor de pagamento configurado.');
  }
}
