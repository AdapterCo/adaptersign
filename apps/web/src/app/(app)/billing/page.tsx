'use client';

import { Suspense, useCallback, useState } from 'react';
import { api, type Paginated } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatDate, formatDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/components/session';
import { PaymentPanel } from '@/components/payment-panel';
import { Alert, Button, Card, ErrorMessage, PageHeader, Spinner } from '@/components/ui';

interface Overview {
  onlinePayment: boolean;
  publicKey: string | null;
  current: { code: string; name: string; paid: boolean; periodEnd: string | null; expired: boolean };
  quota: { limit: number | null; bonus: number; used: number; credits: number; next: 'plan' | 'bonus' | 'credit' | 'unlimited' | null };
  plans: Array<{
    code: string;
    name: string;
    priceCents: number | null;
    purchasable: boolean;
    bonusPercent: number;
    limits: { monthlyEnvelopes: number | null; users: number | null; apiAccess: boolean; webhooks: boolean };
  }>;
  creditPacks: Array<{ code: string; name: string; documents: number; priceCents: number; purchasable: boolean }>;
}

interface Payment {
  id: string;
  kind: 'PLAN' | 'CREDITS';
  plan: { name: string } | null;
  creditPack: { name: string } | null;
  documents: number | null;
  status: string;
  amountCents: number;
  paymentType: string | null;
  approvedAt: string | null;
  periodEnd: string | null;
  createdAt: string;
  payable: boolean;
}

const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function Billing() {
  const { can, me } = useSession();
  const manage = can('org:settings');
  const { data, error, reload } = useApi<Overview>('/billing');
  const { data: history, reload: reloadHistory } = useApi<Paginated<Payment>>(manage ? '/billing/payments?pageSize=10' : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [order, setOrder] = useState<{ paymentId: string; title: string; amountCents: number } | null>(null);
  const refresh = useCallback(() => {
    void reload();
    void reloadHistory();
  }, [reload, reloadHistory]);

  async function buy(body: { planCode: string } | { packCode: string }, key: string) {
    setBusy(key);
    setActionError(null);
    try {
      // Pedido criado no backend (valor definido lá); o pagamento é feito no painel abaixo.
      const r = await api<{ paymentId: string; amountCents: number; description: string }>('/billing/checkout', { method: 'POST', body });
      setOrder({ paymentId: r.paymentId, title: r.description, amountCents: r.amountCents });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorMessage error={error} />;
  if (!data) return <Spinner label={t.common.loading} />;
  const q = data.quota;
  const total = q.limit === null ? null : q.limit + q.bonus;
  const pct = total ? Math.min(100, Math.round((q.used / total) * 100)) : 0;

  return (
    <>
      <PageHeader title={t.billing.title} />
      <div className="flex flex-col gap-6">
        {order && (
          <PaymentPanel
            key={order.paymentId}
            paymentId={order.paymentId}
            title={order.title}
            amountCents={order.amountCents}
            publicKey={data.publicKey}
            payerEmail={me?.user.email ?? ''}
            onPaid={refresh}
            onClose={() => setOrder(null)}
          />
        )}

        <Card title={t.billing.current}>
          <p className="text-lg font-semibold">{data.current.name}</p>
          {data.current.periodEnd && <p className="text-sm text-muted">{t.billing.validUntil(formatDate(data.current.periodEnd))}</p>}
          {data.current.expired && <Alert tone="warn">{t.billing.expired}</Alert>}
          {total !== null ? (
            <div className="mt-4">
              <div className="flex justify-between text-sm">
                <span>{t.billing.usage(q.used, q.limit!)}</span>
                {q.bonus > 0 && <span className="text-muted">{t.billing.bonus(q.bonus)}</span>}
              </div>
              <div className="mt-2 h-2 rounded-full bg-canvas" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-2 rounded-full ${q.next === null ? 'bg-bad' : q.next === 'bonus' || q.next === 'credit' ? 'bg-warn' : 'bg-brand'}`} style={{ width: `${pct}%` }} />
              </div>
              {q.next === 'bonus' && <p className="mt-2 text-sm text-ok">{t.billing.usingBonus}</p>}
              <p className="mt-2 text-sm">{t.billing.credits(q.credits)}</p>
              {q.next === null && <Alert tone="warn">{data.current.paid ? t.billing.exhaustedPaid : t.billing.exhaustedFree}</Alert>}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">{t.billing.unlimited}</p>
          )}
        </Card>

        {!data.onlinePayment && <Alert tone="info">{t.billing.offline}</Alert>}
        {!manage && <p className="text-sm text-muted">{t.billing.ownerOnly}</p>}
        <ErrorMessage error={actionError} />

        <Card title={t.billing.plans}>
          <p className="mb-4 text-sm text-muted">{t.billing.plansHelp}</p>
          {!data.plans.some((p) => p.priceCents) && <Alert tone="info">{t.billing.noPlans}</Alert>}
          <div className="grid gap-4 sm:grid-cols-3">
            {data.plans
              .filter((p) => p.priceCents)
              .map((p) => {
                const isCurrent = p.code === data.current.code;
                return (
                  <div key={p.code} className={`flex flex-col rounded-xl border p-4 ${isCurrent ? 'border-brand' : 'border-line'}`}>
                    <p className="font-semibold">{p.name}</p>
                    <p className="mt-1 text-2xl font-bold">
                      {brl(p.priceCents!)}
                      <span className="text-sm font-normal text-muted">{t.billing.perMonth}</span>
                    </p>
                    <ul className="mt-3 flex-1 space-y-1 text-sm">
                      <li>{p.limits.monthlyEnvelopes === null ? t.billing.unlimitedDocs : t.billing.docsPerMonth(p.limits.monthlyEnvelopes)}</li>
                      {p.bonusPercent > 0 && p.limits.monthlyEnvelopes !== null && (
                        <li className="text-ok">{t.billing.bonusFeature(Math.ceil((p.limits.monthlyEnvelopes * p.bonusPercent) / 100))}</li>
                      )}
                      {p.limits.users !== null && <li>{t.billing.users(p.limits.users)}</li>}
                      {p.limits.apiAccess && <li>{t.billing.api}</li>}
                    </ul>
                    {manage && (
                      <Button
                        className="mt-4"
                        variant={isCurrent ? 'secondary' : 'primary'}
                        disabled={!p.purchasable || !!busy}
                        loading={busy === p.code}
                        onClick={() => void buy({ planCode: p.code }, p.code)}
                      >
                        {isCurrent ? t.billing.renew : t.billing.subscribe}
                      </Button>
                    )}
                    {manage && !isCurrent && data.current.paid && data.current.periodEnd && <p className="mt-2 text-xs text-muted">{t.billing.changeNote}</p>}
                  </div>
                );
              })}
          </div>
          <p className="mt-4 text-xs text-muted">{t.billing.paymentNote}</p>
        </Card>

        <Card title={t.billing.extras}>
          <p className="mb-4 text-sm text-muted">{data.current.paid ? t.billing.extrasHelp : t.billing.extrasPaidOnly}</p>
          {data.creditPacks.length === 0 && <Alert tone="info">{t.billing.noPacks}</Alert>}
          <div className="grid gap-4 sm:grid-cols-3">
            {data.creditPacks.map((k) => (
              <div key={k.code} className="flex flex-col rounded-xl border border-line p-4">
                <p className="font-semibold">{t.billing.packDocs(k.documents)}</p>
                <p className="mt-1 text-xl font-bold">{brl(k.priceCents)}</p>
                <p className="text-xs text-muted">{t.billing.perDoc(brl(Math.round(k.priceCents / k.documents)))}</p>
                {manage && (
                  <Button
                    className="mt-4"
                    variant="secondary"
                    disabled={!k.purchasable || !!busy}
                    loading={busy === k.code}
                    onClick={() => void buy({ packCode: k.code }, k.code)}
                  >
                    {t.billing.buy}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>

        {manage && history && history.data.length > 0 && (
          <Card title={t.billing.history}>
            <ul className="divide-y divide-line text-sm">
              {history.data.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <p className="font-medium">{p.kind === 'PLAN' ? t.billing.planItem(p.plan?.name ?? '') : t.billing.packDocs(p.documents ?? 0)}</p>
                    <p className="text-xs text-muted">
                      {formatDateTime(p.createdAt)}
                      {p.paymentType && ` · ${t.billing.method[p.paymentType] ?? p.paymentType}`}
                      {p.periodEnd && ` · ${t.billing.validUntil(formatDate(p.periodEnd))}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-right">
                    <div>
                      <p className="font-semibold">{brl(p.amountCents)}</p>
                      <p className="text-xs">{t.billing.status[p.status] ?? p.status}</p>
                    </div>
                    {p.payable && p.status !== 'APPROVED' && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOrder({ paymentId: p.id, title: p.kind === 'PLAN' ? t.billing.planItem(p.plan?.name ?? '') : t.billing.packDocs(p.documents ?? 0), amountCents: p.amountCents });
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        {t.billing.pay}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<Spinner label={t.common.loading} />}>
      <Billing />
    </Suspense>
  );
}
