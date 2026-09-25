'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, downloadFile } from '@/lib/api';
import { branding } from '@/lib/branding';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { PdfViewer } from '@/components/pdf-viewer';
import { SignaturePad } from '@/components/signature-pad';
import { Alert, Button, Card, ErrorMessage, Field, Input, Spinner, Textarea } from '@/components/ui';

type OtpChannel = 'EMAIL' | 'WHATSAPP';

interface SignState {
  envelope: { title: string; message: string | null; status: string; organizationName: string; expiresAt: string | null; validationCode: string; finalizing: boolean };
  signer: {
    name: string;
    email: string;
    status: string;
    authenticated: boolean;
    requiresOtp: boolean;
    canSign: boolean;
    signedAt: string | null;
    authMethodLabel: string;
    otp: { channels: OtpChannel[]; defaultChannel: OtpChannel | null; destinations: { EMAIL: string; WHATSAPP: string | null } } | null;
  };
  documents: Array<{
    id: string;
    filename: string;
    pageCount: number;
    sha256: string;
    finalAvailable: boolean;
    finalSha256: string | null;
    fields: Array<{ type: string; page: number; x: number; y: number; width: number; height: number }>;
  }>;
  consent: { version: string; text: string };
}

export default function SignPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<SignState | null>(null);
  const [fatal, setFatal] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [otpSent, setOtpSent] = useState<string | null>(null);
  const [otpChannel, setOtpChannel] = useState<OtpChannel | null>(null);
  const [code, setCode] = useState('');
  const [docIndex, setDocIndex] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [method, setMethod] = useState<'TYPED' | 'DRAWN'>('TYPED');
  const [typedName, setTypedName] = useState('');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declined, setDeclined] = useState(false);
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    api<SignState>('/sign/sessions', { method: 'POST', body: { token }, noRefresh: true })
      .then((s) => {
        setState(s);
        setTypedName(s.signer.name);
      })
      .catch(setFatal);
  }, [token]);

  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const requestOtp = (channel?: OtpChannel) =>
    act(async () => {
      const r = await api<{ destination: string; channel: OtpChannel }>('/sign/otp/request', {
        method: 'POST',
        body: channel ? { channel } : {},
        noRefresh: true,
      });
      setOtpSent(r.destination);
      setOtpChannel(r.channel);
    });

  const verifyOtp = () => act(async () => setState(await api<SignState>('/sign/otp/verify', { method: 'POST', body: { code }, noRefresh: true })));

  const sign = () =>
    act(async () => {
      const r = await api<{ state: SignState }>('/sign/sign', {
        method: 'POST',
        noRefresh: true,
        body: {
          consentAccepted: consent,
          consentVersion: state!.consent.version,
          method,
          ...(method === 'TYPED' ? { typedName } : { imageDataUrl: drawn }),
          documentHashes: Object.fromEntries(state!.documents.map((d) => [d.id, d.sha256])),
        },
      });
      setState(r.state);
    });

  const decline = () =>
    act(async () => {
      await api('/sign/decline', { method: 'POST', body: { reason: declineReason || undefined }, noRefresh: true });
      setDeclined(true);
    });

  const header = (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <span className="font-bold text-brand">{branding.name}</span>
        {state && <span className="text-xs text-muted">{t.sign.from(state.envelope.organizationName)}</span>}
      </div>
    </header>
  );

  if (fatal) {
    const code = fatal instanceof ApiError ? fatal.code : '';
    return (
      <>
        {header}
        <main className="mx-auto max-w-lg px-4 py-10">
          <Card title={code === 'ENVELOPE_EXPIRED' || code === 'ENVELOPE_NOT_AVAILABLE' ? t.sign.notAvailable : t.sign.invalid}>
            <ErrorMessage error={fatal} />
            <p className="mt-3 text-sm text-muted">{t.sign.invalidHelp}</p>
          </Card>
        </main>
      </>
    );
  }

  if (!state) {
    return (
      <>
        {header}
        <main className="flex justify-center px-4 py-16">
          <Spinner label={t.sign.loading} />
        </main>
      </>
    );
  }

  const { envelope, signer, documents } = state;
  const completed = envelope.status === 'COMPLETED';
  const signed = signer.status === 'SIGNED';
  const unavailable = !['ACTIVE', 'PARTIALLY_SIGNED', 'COMPLETED'].includes(envelope.status) && !signed;
  const doc = documents[docIndex];

  return (
    <>
      {header}
      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">{envelope.title}</h1>
          <p className="text-sm text-muted">
            {signer.name} · {signer.email}
            {envelope.expiresAt && ` · ${t.envelopes.expiresAt}: ${formatDateTime(envelope.expiresAt)}`}
          </p>
          {envelope.message && <p className="mt-3 rounded-lg bg-white p-3 text-sm">“{envelope.message}”</p>}
        </div>

        <ErrorMessage error={error} />

        {declined || signer.status === 'DECLINED' ? (
          <Alert tone="warn">{t.sign.declinedTitle}</Alert>
        ) : unavailable ? (
          <Alert tone="warn">{t.sign.notAvailable}</Alert>
        ) : !signer.authenticated ? (
          /* Etapa: autenticação */
          <Card title={t.sign.authTitle}>
            {!otpSent ? (
              <>
                {(() => {
                  const otp = signer.otp;
                  const first = otp?.defaultChannel ?? 'EMAIL';
                  const dest = (c: OtpChannel) => (c === 'WHATSAPP' ? (otp?.destinations.WHATSAPP ?? '') : (otp?.destinations.EMAIL ?? signer.email));
                  const others = (otp?.channels ?? []).filter((c) => c !== first);
                  return (
                    <>
                      <p className="mb-4 text-sm">{first === 'WHATSAPP' ? t.sign.authOtpHelpWhatsApp(dest(first)) : t.sign.authOtpHelp(dest(first))}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => requestOtp(first)} loading={busy} className="w-full sm:w-auto">
                          {t.sign.sendCode}
                        </Button>
                        {others.map((c) => (
                          <Button key={c} variant="ghost" onClick={() => requestOtp(c)} disabled={busy}>
                            {c === 'WHATSAPP' ? t.sign.sendByWhatsApp : t.sign.sendByEmail}
                          </Button>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </>
            ) : (
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void verifyOtp();
                }}
              >
                <Alert tone="info">{otpChannel === 'WHATSAPP' ? t.sign.codeSentWhatsApp(otpSent) : t.sign.codeSent(otpSent)}</Alert>
                <Field label={t.sign.code}>
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      className="text-center text-2xl tracking-[0.5em]"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    />
                  )}
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={busy} disabled={code.length !== 6}>
                    {t.sign.verify}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => requestOtp(otpChannel ?? undefined)} disabled={busy}>
                    {t.sign.resend}
                  </Button>
                  {(signer.otp?.channels ?? [])
                    .filter((c) => c !== otpChannel)
                    .map((c) => (
                      <Button key={c} type="button" variant="ghost" onClick={() => requestOtp(c)} disabled={busy}>
                        {c === 'WHATSAPP' ? t.sign.sendByWhatsApp : t.sign.sendByEmail}
                      </Button>
                    ))}
                </div>
              </form>
            )}
          </Card>
        ) : completed ? (
          <Card title={t.sign.completedTitle}>
            <p className="mb-4 text-sm">{t.sign.completedText}</p>
            <ul className="flex flex-col gap-2">
              {documents.map((d) => (
                <li key={d.id}>
                  <Button variant="secondary" className="w-full justify-between" onClick={() => downloadFile(`/sign/documents/${d.id}/content?mode=download`, d.filename)}>
                    {d.filename}
                    <span>{t.common.download}</span>
                  </Button>
                </li>
              ))}
              <li>
                <Button variant="ghost" onClick={() => downloadFile('/sign/evidence', 'evidencias.pdf')}>
                  {t.sign.evidence}
                </Button>
              </li>
            </ul>
            <p className="mt-4 text-xs text-muted">
              {t.envelopes.validationCode}: <span className="font-mono">{envelope.validationCode}</span>
            </p>
          </Card>
        ) : signed ? (
          <Alert tone="ok">
            <strong>{t.sign.doneTitle}.</strong> {t.sign.doneText}
          </Alert>
        ) : (
          <>
            {/* Etapa: leitura do documento */}
            <Card
              title={documents.length > 1 ? t.sign.documentOf(docIndex + 1, documents.length) : t.sign.reviewTitle}
              actions={
                <Button variant="ghost" onClick={() => downloadFile(`/sign/documents/${doc.id}/content?mode=download`, doc.filename)}>
                  {t.sign.downloadOriginal}
                </Button>
              }
            >
              <p className="mb-2 text-sm font-medium break-all">{doc.filename}</p>
              {doc.fields.length > 0 && <p className="mb-2 text-xs text-brand">{t.fields.yourFields}</p>}
              <PdfViewer
                path={`/sign/documents/${doc.id}/content?mode=view`}
                title={doc.filename}
                overlay={(page) =>
                  doc.fields
                    .filter((f) => f.page === page)
                    .map((f, i) => (
                      <div
                        key={i}
                        className="absolute flex items-center justify-center rounded-sm border-2 border-dashed border-brand bg-brand/15 text-[10px] font-semibold text-brand"
                        style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` }}
                      >
                        <span className="truncate px-1">{t.fields.types[f.type] ?? f.type}</span>
                      </div>
                    ))
                }
              />
              <p className="mt-2 text-xs break-all text-muted">
                {t.sign.hashNote} <span className="font-mono">{doc.sha256}</span>
              </p>
              {documents.length > 1 && (
                <div className="mt-4 flex justify-between">
                  <Button variant="secondary" disabled={docIndex === 0} onClick={() => setDocIndex(docIndex - 1)}>
                    {t.common.previous}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={docIndex === documents.length - 1}
                    onClick={() => {
                      setDocIndex(docIndex + 1);
                      if (docIndex + 1 === documents.length - 1) setReviewed(true);
                    }}
                  >
                    {t.common.nextPage}
                  </Button>
                </div>
              )}
            </Card>

            {!signer.canSign ? (
              <Alert tone="info">{envelope.finalizing ? t.envelopes.finalizing : t.sign.notYourTurn}</Alert>
            ) : (
              /* Etapas: aceite + assinatura */
              <Card title={t.sign.signTitle}>
                <div className="flex flex-col gap-5">
                  <div className="flex gap-2" role="tablist" aria-label={t.sign.signTitle}>
                    {(['TYPED', 'DRAWN'] as const).map((m) => (
                      <button
                        key={m}
                        role="tab"
                        aria-selected={method === m}
                        onClick={() => setMethod(m)}
                        className={`min-h-11 flex-1 rounded-lg border px-3 text-sm font-semibold ${method === m ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-white'}`}
                      >
                        {m === 'TYPED' ? t.sign.typed : t.sign.drawn}
                      </button>
                    ))}
                  </div>
                  {method === 'TYPED' ? (
                    <Field label={t.sign.typeName}>
                      {(id) => <Input id={id} value={typedName} maxLength={120} className="font-serif text-xl italic" onChange={(e) => setTypedName(e.target.value)} />}
                    </Field>
                  ) : (
                    <SignaturePad onChange={setDrawn} />
                  )}
                  <p className="text-xs text-muted">{t.sign.visualNote}</p>
                  <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
                    <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    <span>
                      {state.consent.text}
                      <span className="mt-1 block text-xs text-muted">v{state.consent.version}</span>
                    </span>
                  </label>
                  <Button
                    onClick={sign}
                    loading={busy}
                    disabled={!consent || (documents.length > 1 && !reviewed) || (method === 'TYPED' ? typedName.trim().length < 2 : !drawn)}
                    className="w-full"
                  >
                    {busy ? t.sign.signing : t.sign.signButton}
                  </Button>
                  {!declineOpen ? (
                    <Button variant="ghost" onClick={() => setDeclineOpen(true)}>
                      {t.sign.declineButton}
                    </Button>
                  ) : (
                    <div className="flex flex-col gap-3 rounded-lg border border-bad/30 p-3">
                      <Field label={t.sign.declineReason}>{(id) => <Textarea id={id} maxLength={500} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />}</Field>
                      <div className="flex gap-2">
                        <Button variant="danger" onClick={decline} loading={busy}>
                          {t.sign.declineConfirm}
                        </Button>
                        <Button variant="secondary" onClick={() => setDeclineOpen(false)}>
                          {t.common.cancel}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )}
          </>
        )}
      </main>
    </>
  );
}
