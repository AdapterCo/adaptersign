'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { Alert, Button, ErrorMessage, Spinner } from '@/components/ui';

export interface PaymentView {
  id: string;
  kind: 'PLAN' | 'CREDITS';
  plan: { name: string } | null;
  documents: number | null;
  status: string;
  statusDetail: string | null;
  payable: boolean;
  amountCents: number;
  pix: { qrCode: string; qrCodeBase64: string | null; expiresAt: string } | null;
}

interface CardFormData {
  token: string;
  payment_method_id: string;
  issuer_id?: string | number;
  payer?: { email?: string; identification?: { type?: string; number?: string } };
}

interface BrickController {
  unmount: () => void;
}

declare global {
  interface Window {
    MercadoPago?: new (
      publicKey: string,
      opts: { locale: string },
    ) => {
      bricks: () => { create: (type: 'cardPayment', containerId: string, settings: unknown) => Promise<BrickController> };
    };
  }
}

const SDK_URL = 'https://sdk.mercadopago.com/js/v2';
const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function loadSdk(): Promise<void> {
  if (window.MercadoPago) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('sdk')));
    if (!existing) {
      script.src = SDK_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

/**
 * Pagamento dentro do Adapter Sign. Nada aqui define valor ou aprova pagamento: o valor vem do
 * pedido no backend, o Pix é gerado pelo backend e o cartão vira um token de uso único no
 * componente do Mercado Pago — a cobrança e a confirmação acontecem somente no servidor.
 */
export function PaymentPanel({
  paymentId,
  title,
  amountCents,
  publicKey,
  payerEmail,
  onPaid,
  onClose,
}: {
  paymentId: string;
  title: string;
  amountCents: number;
  publicKey: string | null;
  payerEmail: string;
  onPaid: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'pix' | 'card'>('pix');
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [cardReady, setCardReady] = useState(false);
  const brick = useRef<BrickController | null>(null);
  const approved = payment?.status === 'APPROVED';

  const refresh = useCallback(async () => {
    const p = await api<PaymentView>(`/billing/payments/${paymentId}`);
    setPayment(p);
    if (p.status === 'APPROVED') onPaid();
    return p;
  }, [paymentId, onPaid]);

  // Aguarda a confirmação (consultada no backend) enquanto houver Pix aberto ou cartão em análise.
  const waiting = !approved && (!!payment?.pix || payment?.status === 'IN_PROCESS');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  async function generatePix() {
    setBusy(true);
    setError(null);
    try {
      setPayment(await api<PaymentView>(`/billing/payments/${paymentId}/pix`, { method: 'POST' }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  // Componente de cartão do Mercado Pago (somente com a chave PÚBLICA).
  useEffect(() => {
    if (tab !== 'card' || approved || !publicKey) return;
    let cancelled = false;
    setCardReady(false);
    void (async () => {
      try {
        await loadSdk();
        if (cancelled || !window.MercadoPago) return;
        const mp = new window.MercadoPago(publicKey, { locale: 'pt-BR' });
        brick.current = await mp.bricks().create('cardPayment', 'mp-card-brick', {
          // Valor apenas exibido pelo componente; o backend cobra o valor do pedido.
          initialization: { amount: amountCents / 100, payer: { email: payerEmail } },
          customization: { paymentMethods: { minInstallments: 1, maxInstallments: 1 } },
          callbacks: {
            onReady: () => {
              if (!cancelled) setCardReady(true);
            },
            onError: () => {
              if (!cancelled) setError(new Error(t.billing.cardLoadError));
            },
            onSubmit: async (data: CardFormData) => {
              setError(null);
              try {
                const p = await api<PaymentView>(`/billing/payments/${paymentId}/card`, {
                  method: 'POST',
                  body: {
                    token: data.token,
                    paymentMethodId: data.payment_method_id,
                    ...(data.issuer_id ? { issuerId: String(data.issuer_id) } : {}),
                    ...(data.payer?.email ? { payerEmail: data.payer.email } : {}),
                    ...(data.payer?.identification?.type && data.payer.identification.number
                      ? { identificationType: data.payer.identification.type, identificationNumber: data.payer.identification.number }
                      : {}),
                  },
                });
                setPayment(p);
                if (p.status === 'APPROVED') onPaid();
              } catch (err) {
                setError(err);
              }
            },
          },
        });
      } catch {
        if (!cancelled) setError(new Error(t.billing.cardLoadError));
      }
    })();
    return () => {
      cancelled = true;
      brick.current?.unmount();
      brick.current = null;
    };
  }, [tab, approved, publicKey, amountCents, payerEmail, paymentId, onPaid]);

  const rejected = payment?.status === 'REJECTED';
  return (
    <div className="rounded-xl border border-brand bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{t.billing.paying}</p>
          <p className="font-semibold">{title}</p>
          <p className="text-xl font-bold">{brl(amountCents)}</p>
        </div>
        {!approved && (
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
        )}
      </div>

      {approved ? (
        <Alert tone="ok">{payment.kind === 'PLAN' ? t.billing.approvedPlan(payment.plan?.name ?? '') : t.billing.approvedCredits(payment.documents ?? 0)}</Alert>
      ) : (
        <>
          <div role="tablist" className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-canvas p-1">
            {(['pix', 'card'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => {
                  setError(null);
                  setTab(k);
                }}
                className={`min-h-10 rounded-md text-sm font-semibold ${tab === k ? 'bg-brand text-white' : 'text-ink hover:bg-white'}`}
              >
                {k === 'pix' ? t.billing.tabPix : t.billing.tabCard}
              </button>
            ))}
          </div>

          {tab === 'pix' &&
            (payment?.pix ? (
              <div className="flex flex-col items-center gap-3">
                {payment.pix.qrCodeBase64 && (
                  <img src={`data:image/png;base64,${payment.pix.qrCodeBase64}`} alt={t.billing.pixQrAlt} className="h-56 w-56 rounded-lg border border-line bg-white p-2" />
                )}
                <textarea readOnly value={payment.pix.qrCode} className="h-24 w-full rounded-lg border border-line p-2 font-mono text-xs" aria-label={t.billing.pixCode} />
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() =>
                    void navigator.clipboard.writeText(payment.pix!.qrCode).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 3000);
                    })
                  }
                >
                  {copied ? t.billing.copied : t.billing.copyPix}
                </Button>
                <p className="text-center text-xs text-muted">{t.billing.pixWaiting(formatDateTime(payment.pix.expiresAt))}</p>
              </div>
            ) : (
              <Button className="w-full" loading={busy} onClick={() => void generatePix()}>
                {t.billing.generatePix}
              </Button>
            ))}

          {tab === 'card' && (
            <div>
              {!publicKey && <Alert tone="warn">{t.billing.cardUnavailable}</Alert>}
              {rejected && <Alert tone="warn">{t.billing.rejected(payment.statusDetail)}</Alert>}
              {payment?.status === 'IN_PROCESS' && <Alert tone="info">{t.billing.inProcess}</Alert>}
              {publicKey && !cardReady && <Spinner label={t.common.loading} />}
              <div id="mp-card-brick" />
              <p className="mt-2 text-xs text-muted">{t.billing.cardNote}</p>
            </div>
          )}
          <div className="mt-3">
            <ErrorMessage error={error} />
          </div>
        </>
      )}
    </div>
  );
}
