'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api, newIdempotencyKey, type Paginated } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { Alert, Button, Card, ErrorMessage, Field, Input, PageHeader, Select, Spinner, Textarea } from '@/components/ui';
import type { DocumentRow, EnvelopeDetail } from '@/lib/types';

interface SignerDraft {
  key: string;
  id?: string; // signatário já salvo no rascunho
  name: string;
  email: string;
  phone: string;
  cpf: string;
  role: 'SIGNER' | 'APPROVER' | 'WITNESS';
  signingGroup: number;
  authMethod: string;
  required: boolean;
}

interface AuthMethodInfo {
  method: string;
  available: boolean;
  label: string;
  unavailableReason?: string;
}

const newSigner = (group: number): SignerDraft => ({
  key: crypto.randomUUID(),
  name: '',
  email: '',
  phone: '',
  cpf: '',
  role: 'SIGNER',
  signingGroup: group,
  authMethod: 'EMAIL_OTP',
  required: true,
});

function Wizard() {
  const router = useRouter();
  const draftId = useSearchParams().get('draft');
  const steps = t.wizard.steps;
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [docIds, setDocIds] = useState<string[]>([]);
  const [existingDocs, setExistingDocs] = useState<Record<string, string>>({}); // documentId -> envelopeDocumentId
  const [signers, setSigners] = useState<SignerDraft[]>([newSigner(1)]);
  const [mode, setMode] = useState<'PARALLEL' | 'SEQUENTIAL'>('PARALLEL');
  const [expiresAt, setExpiresAt] = useState('');
  const [reminder, setReminder] = useState('');
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const idemCreate = useRef(newIdempotencyKey());
  const idemActivate = useRef(newIdempotencyKey());

  const docs = useApi<Paginated<DocumentRow>>('/documents?pageSize=100');
  const methods = useApi<AuthMethodInfo[]>('/envelopes/auth-methods');

  // Continuação de rascunho existente.
  useEffect(() => {
    if (!draftId) return;
    api<EnvelopeDetail>(`/envelopes/${draftId}`)
      .then((env) => {
        setTitle(env.title);
        setMessage(env.message ?? '');
        setMode(env.signingMode);
        setExpiresAt(env.expiresAt ? env.expiresAt.slice(0, 16) : '');
        setDocIds(env.documents.map((d) => d.documentId));
        setExistingDocs(Object.fromEntries(env.documents.map((d) => [d.documentId, d.id])));
        if (env.signers.length) {
          setSigners(
            env.signers.map((s) => ({
              key: s.id,
              id: s.id,
              name: s.name,
              email: s.email,
              phone: s.phone ?? '',
              cpf: '',
              role: s.role as SignerDraft['role'],
              signingGroup: s.signingGroup,
              authMethod: s.authMethod,
              required: s.required,
            })),
          );
        }
      })
      .catch(setError);
  }, [draftId]);

  function validateStep(i: number): string | null {
    if (i === 0 && (!title.trim() || docIds.length === 0)) return t.wizard.needDocument;
    if (i === 1 && (signers.length === 0 || signers.some((s) => !s.name.trim() || !/^\S+@\S+\.\S+$/.test(s.email)))) return t.wizard.needSigner;
    return null;
  }

  function go(next: number) {
    if (next > step) {
      const v = validateStep(step);
      setValidation(v);
      if (v) return;
    }
    setValidation(null);
    setStep(next);
  }

  const updateSigner = (key: string, patch: Partial<SignerDraft>) => setSigners((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  function signerPayload(s: SignerDraft) {
    return {
      name: s.name.trim(),
      email: s.email.trim(),
      ...(s.phone.trim() ? { phone: s.phone.trim() } : {}),
      ...(s.cpf ? { cpf: s.cpf } : {}),
      role: s.role,
      signingGroup: mode === 'SEQUENTIAL' ? s.signingGroup : 1,
      authMethod: s.authMethod,
      required: s.required,
    };
  }

  const envelopeFields = () => ({
    title: title.trim(),
    message: message.trim() || undefined,
    signingMode: mode,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    reminderIntervalHours: reminder ? Number(reminder) : undefined,
  });

  /** Cria (ou sincroniza o rascunho) e retorna o id do envelope. */
  async function persist(): Promise<string> {
    if (!draftId) {
      const env = await api<{ id: string }>('/envelopes', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemCreate.current },
        body: { ...envelopeFields(), documents: docIds.map((documentId) => ({ documentId })), signers: signers.map(signerPayload) },
      });
      return env.id;
    }
    await api(`/envelopes/${draftId}`, { method: 'PATCH', body: { ...envelopeFields(), expiresAt: envelopeFields().expiresAt ?? null } });
    for (const [documentId, edId] of Object.entries(existingDocs)) {
      if (!docIds.includes(documentId)) await api(`/envelopes/${draftId}/documents/${edId}`, { method: 'DELETE' });
    }
    for (const documentId of docIds) {
      if (!existingDocs[documentId]) await api(`/envelopes/${draftId}/documents`, { method: 'POST', body: { documentId } });
    }
    // Signatários: remove e recria para refletir exatamente o estado do wizard (somente rascunho).
    const current = await api<EnvelopeDetail>(`/envelopes/${draftId}`);
    for (const s of current.signers) await api(`/envelopes/${draftId}/signers/${s.id}`, { method: 'DELETE' });
    for (const s of signers) await api(`/envelopes/${draftId}/signers`, { method: 'POST', body: signerPayload(s) });
    return draftId;
  }

  async function saveDraft(next: 'detail' | 'fields' = 'detail') {
    setBusy(true);
    setError(null);
    try {
      const id = await persist();
      router.push(next === 'fields' ? `/envelopes/${id}/fields` : `/envelopes/${id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const id = await persist();
      await api(`/envelopes/${id}/activate`, { method: 'POST', headers: { 'Idempotency-Key': idemActivate.current }, body: { confirm: true } });
      router.push(`/envelopes/${id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const availableMethods = methods.data ?? [];
  const selectedDocs = (docs.data?.data ?? []).filter((d) => docIds.includes(d.id));

  return (
    <>
      <PageHeader title={t.envelopes.new} />
      <ol className="mb-6 flex flex-wrap gap-2" aria-label="Etapas">
        {steps.map((s, i) => (
          <li key={s}>
            <button
              onClick={() => (i < step ? go(i) : undefined)}
              aria-current={i === step ? 'step' : undefined}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${i === step ? 'bg-brand text-white' : i < step ? 'bg-brand-soft text-brand' : 'bg-white text-muted'}`}
            >
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      <Card>
        {step === 0 && (
          <div className="flex flex-col gap-4">
            <Field label={t.wizard.title}>{(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t.wizard.pickDocuments}</legend>
              {docs.loading && <Spinner label={t.common.loading} />}
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {(docs.data?.data ?? []).map((d) => (
                  <li key={d.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-line p-3 hover:bg-canvas">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={docIds.includes(d.id)}
                        onChange={(e) => setDocIds(e.target.checked ? [...docIds, d.id] : docIds.filter((x) => x !== d.id))}
                      />
                      <span className="flex-1">
                        <span className="block font-medium">{d.title}</span>
                        <span className="text-xs text-muted">{formatDateTime(d.createdAt)}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                {t.wizard.uploadNew}:{' '}
                <a href="/documents" className="text-brand underline">
                  {t.nav.documents}
                </a>
              </p>
            </fieldset>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4">
            {signers.map((s, i) => (
              <fieldset key={s.key} className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-2">
                <legend className="px-1 text-sm font-semibold">#{i + 1}</legend>
                <Field label={t.wizard.signerName}>{(id) => <Input id={id} value={s.name} onChange={(e) => updateSigner(s.key, { name: e.target.value })} />}</Field>
                <Field label={t.wizard.signerEmail}>{(id) => <Input id={id} type="email" value={s.email} onChange={(e) => updateSigner(s.key, { email: e.target.value })} />}</Field>
                <Field label={t.wizard.signerPhone} hint={t.wizard.signerPhoneHint}>
                  {(id) => <Input id={id} type="tel" inputMode="tel" autoComplete="tel" value={s.phone} onChange={(e) => updateSigner(s.key, { phone: e.target.value })} />}
                </Field>
                <Field label={t.wizard.signerCpf}>{(id) => <Input id={id} inputMode="numeric" value={s.cpf} onChange={(e) => updateSigner(s.key, { cpf: e.target.value })} />}</Field>
                <Field label={t.wizard.signerRole}>
                  {(id) => (
                    <Select id={id} value={s.role} onChange={(e) => updateSigner(s.key, { role: e.target.value as SignerDraft['role'] })}>
                      {Object.entries(t.roles).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-5 w-5" checked={s.required} onChange={(e) => updateSigner(s.key, { required: e.target.checked })} />
                  {t.wizard.required}
                </label>
                <div className="sm:text-right">
                  <Button variant="ghost" onClick={() => setSigners(signers.filter((x) => x.key !== s.key))} disabled={signers.length === 1}>
                    {t.common.remove}
                  </Button>
                </div>
              </fieldset>
            ))}
            <Button variant="secondary" onClick={() => setSigners([...signers, newSigner(Math.max(...signers.map((s) => s.signingGroup), 0) + 1)])}>
              {t.wizard.addSigner}
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              {(['PARALLEL', 'SEQUENTIAL'] as const).map((m) => (
                <label key={m} className="flex items-center gap-3 rounded-lg border border-line p-3">
                  <input type="radio" name="mode" className="h-5 w-5" checked={mode === m} onChange={() => setMode(m)} />
                  {m === 'PARALLEL' ? t.wizard.parallel : t.wizard.sequential}
                </label>
              ))}
            </fieldset>
            {mode === 'SEQUENTIAL' && (
              <ul className="flex flex-col gap-2">
                {signers.map((s) => (
                  <li key={s.key} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
                    <span>{s.name || s.email}</span>
                    <label className="flex items-center gap-2 text-sm">
                      {t.wizard.group}
                      <Input type="number" min={1} max={50} className="w-20" value={s.signingGroup} onChange={(e) => updateSigner(s.key, { signingGroup: Math.max(1, Number(e.target.value)) })} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 3 && (
          <ul className="flex flex-col gap-3">
            {signers.map((s) => (
              <li key={s.key}>
                <Field label={`${t.wizard.authMethod} — ${s.name || s.email}`}>
                  {(id) => (
                    <Select id={id} value={s.authMethod} onChange={(e) => updateSigner(s.key, { authMethod: e.target.value })}>
                      {availableMethods.map((m) => (
                        <option key={m.method} value={m.method} disabled={!m.available}>
                          {m.label}
                          {!m.available ? ` — ${t.common.unavailable}` : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </li>
            ))}
          </ul>
        )}

        {step === 4 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.wizard.expiresAt}>{(id) => <Input id={id} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />}</Field>
            <Field label={t.wizard.reminders}>
              {(id) => (
                <Select id={id} value={reminder} onChange={(e) => setReminder(e.target.value)}>
                  <option value="">{t.wizard.noReminders}</option>
                  {[24, 48, 72].map((h) => (
                    <option key={h} value={h}>
                      {t.wizard.everyHours(h)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}

        {step === 5 && <Field label={t.wizard.message}>{(id) => <Textarea id={id} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>}

        {(step === 6 || step === 7) && (
          <div className="flex flex-col gap-4 text-sm">
            <h2 className="text-base font-semibold">{t.wizard.review}</h2>
            <p>
              <strong>{title}</strong>
            </p>
            <div>
              <p className="font-medium">{t.envelopes.documents}</p>
              <ul className="list-disc pl-5">
                {selectedDocs.map((d) => (
                  <li key={d.id}>{d.title}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium">{t.envelopes.signers}</p>
              <ul className="list-disc pl-5">
                {[...signers]
                  .sort((a, b) => a.signingGroup - b.signingGroup)
                  .map((s) => (
                    <li key={s.key}>
                      {s.name} ({s.email}) — {t.roles[s.role]}
                      {mode === 'SEQUENTIAL' && ` · ${t.envelopes.group(s.signingGroup)}`}
                    </li>
                  ))}
              </ul>
            </div>
            <p>{mode === 'PARALLEL' ? t.wizard.parallel : t.wizard.sequential}</p>
            {expiresAt && (
              <p>
                {t.envelopes.expiresAt}: {formatDateTime(new Date(expiresAt).toISOString())}
              </p>
            )}
            {step === 7 && (
              <label className="flex items-start gap-3 rounded-lg border border-brand/40 bg-brand-soft p-3">
                <input type="checkbox" className="mt-0.5 h-5 w-5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>{t.wizard.confirmSend}</span>
              </label>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3">
          {validation && <Alert tone="warn">{validation}</Alert>}
          <ErrorMessage error={error} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="secondary" onClick={() => go(step - 1)} disabled={step === 0}>
              {t.common.back}
            </Button>
            <div className="flex flex-wrap gap-2">
              {step >= 6 && (
                <Button variant="secondary" loading={busy} onClick={() => void saveDraft('fields')} disabled={!title.trim()}>
                  {t.fields.open}
                </Button>
              )}
              <Button variant="secondary" loading={busy} onClick={() => void saveDraft()} disabled={!title.trim()}>
                {t.wizard.saveDraft}
              </Button>
              {step < 7 ? (
                <Button onClick={() => go(step + 1)}>{t.common.next}</Button>
              ) : (
                <Button onClick={send} loading={busy} disabled={!confirmed}>
                  {t.wizard.send}
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}

export default function NewEnvelopePage() {
  return (
    <Suspense fallback={<Spinner label={t.common.loading} />}>
      <Wizard />
    </Suspense>
  );
}
