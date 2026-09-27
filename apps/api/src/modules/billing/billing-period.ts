import { BillingPaymentStatus } from '../../generated/prisma/client';

/** Soma meses de calendário (31/01 + 1 mês = 28 ou 29/02), em UTC. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * Período liberado por um pagamento aprovado: renovar o MESMO plano ainda vigente soma ao fim do
 * período atual; trocar de plano (ou plano vencido) começa agora.
 */
export function nextPeriod(
  current: { planId: string; status: string; currentPeriodEnd: Date | null } | null,
  planId: string,
  months: number,
  now: Date,
): { start: Date; end: Date; extended: boolean } {
  const extend =
    !!current && current.planId === planId && current.status === 'ACTIVE' && !!current.currentPeriodEnd && current.currentPeriodEnd > now;
  const start = extend ? current.currentPeriodEnd! : now;
  return { start, end: addMonths(start, months), extended: extend };
}

/** Status do Mercado Pago → status interno. */
export function mapProviderStatus(status: string): BillingPaymentStatus | null {
  switch (status) {
    case 'approved':
      return BillingPaymentStatus.APPROVED;
    case 'pending':
    case 'in_process':
    case 'in_mediation':
    case 'authorized':
      return BillingPaymentStatus.IN_PROCESS;
    case 'rejected':
      return BillingPaymentStatus.REJECTED;
    case 'cancelled':
      return BillingPaymentStatus.CANCELLED;
    case 'refunded':
    case 'charged_back':
      return BillingPaymentStatus.REFUNDED;
    default:
      return null;
  }
}

export type QuotaSource = 'plan' | 'bonus' | 'credit' | 'unlimited';

export interface EnvelopeQuota {
  /** Envelopes/mês do plano (null = ilimitado). */
  limit: number | null;
  /** Brinde ao estourar o limite (+N% do contratado, arredondado para cima). */
  bonus: number;
  used: number;
  /** Documentos extras comprados (não expiram). */
  credits: number;
  /** De onde sai o PRÓXIMO envelope; null = sem saldo. */
  next: QuotaSource | null;
}

/** Ordem de consumo: plano → bônus do mês → documentos extras comprados. */
export function envelopeQuota(plan: { monthlyEnvelopes: number | null; overageBonusPercent: number }, used: number, credits: number): EnvelopeQuota {
  if (plan.monthlyEnvelopes === null) return { limit: null, bonus: 0, used, credits, next: 'unlimited' };
  const limit = plan.monthlyEnvelopes;
  const bonus = Math.ceil((limit * Math.max(0, plan.overageBonusPercent)) / 100);
  const next: QuotaSource | null = used < limit ? 'plan' : used < limit + bonus ? 'bonus' : credits > 0 ? 'credit' : null;
  return { limit, bonus, used, credits, next };
}
