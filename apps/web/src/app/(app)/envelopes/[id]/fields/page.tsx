'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useApi } from '@/lib/use-api';
import type { AnchorIssues, EnvelopeDetail, EnvelopeField, FieldType, Template } from '@/lib/types';
import { PdfViewer } from '@/components/pdf-viewer';
import { useSession } from '@/components/session';
import { AnchorIssuesList } from '@/components/templates';
import { Alert, Button, Card, ErrorMessage, Field, PageHeader, Select, Spinner } from '@/components/ui';

type LocalField = EnvelopeField & { key: string };

const COLORS = ['#1F4FD1', '#0A7A48', '#A15C00', '#B42318', '#6B21A8', '#0E7490'];
const TYPES: FieldType[] = ['SIGNATURE', 'INITIALS', 'NAME', 'DATE'];
// Tamanho padrão (fração da página) por tipo de campo.
const DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  SIGNATURE: { w: 0.3, h: 0.05 },
  INITIALS: { w: 0.1, h: 0.04 },
  NAME: { w: 0.3, h: 0.03 },
  DATE: { w: 0.18, h: 0.03 },
};
const MIN = 0.01;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Drag {
  key: string;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  rect: DOMRect;
  orig: { x: number; y: number; width: number; height: number };
}

export default function FieldsEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: env, error, loading } = useApi<EnvelopeDetail>(`/envelopes/${id}`);
  const { can } = useSession();
  const { data: templates } = useApi<Template[]>(can('template:read') ? '/templates' : null);
  const [templateId, setTemplateId] = useState('');
  const [roleSigners, setRoleSigners] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<AnchorIssues | null>(null);
  const [fields, setFields] = useState<LocalField[]>([]);
  const [docId, setDocId] = useState('');
  const [signerId, setSignerId] = useState('');
  const [type, setType] = useState<FieldType>('SIGNATURE');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const drag = useRef<Drag | null>(null);
  const idemActivate = useRef(newIdempotencyKey());

  useEffect(() => {
    if (!env) return;
    setFields(env.fields.map((f) => ({ ...f, key: f.id ?? crypto.randomUUID() })));
    setDocId((d) => d || env.documents[0]?.id || '');
    setSignerId((s) => s || env.signers[0]?.id || '');
  }, [env]);

  if (loading && !env) return <Spinner label={t.common.loading} />;
  if (!env) return <ErrorMessage error={error} />;

  const editable = env.status === 'DRAFT';
  const doc = env.documents.find((d) => d.id === docId);
  const colorOf = (sid: string) => COLORS[Math.max(0, env.signers.findIndex((s) => s.id === sid)) % COLORS.length];
  const nameOf = (sid: string) => env.signers.find((s) => s.id === sid)?.name ?? '';

  function addField(page: number, fx: number, fy: number) {
    if (!editable || !doc || !signerId) return;
    const size = DEFAULT_SIZE[type];
    const x = clamp(fx - size.w / 2, 0, 1 - size.w);
    const y = clamp(fy - size.h / 2, 0, 1 - size.h);
    setFields((list) => [...list, { key: crypto.randomUUID(), envelopeDocumentId: doc.id, signerId, type, page, x, y, width: size.w, height: size.h }]);
    setDirty(true);
    setNotice(null);
  }

  function startDrag(e: ReactPointerEvent<HTMLElement>, f: LocalField, mode: Drag['mode']) {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    // Medidas relativas à PÁGINA inteira (camada de sobreposição), não ao campo.
    const layer = e.currentTarget.closest('[data-page-layer]') as HTMLElement | null;
    if (!layer) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { key: f.key, mode, startX: e.clientX, startY: e.clientY, rect: layer.getBoundingClientRect(), orig: { x: f.x, y: f.y, width: f.width, height: f.height } };
  }

  function onDrag(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.rect.width;
    const dy = (e.clientY - d.startY) / d.rect.height;
    setFields((list) =>
      list.map((f) => {
        if (f.key !== d.key) return f;
        if (d.mode === 'move') {
          return { ...f, x: clamp(d.orig.x + dx, 0, 1 - f.width), y: clamp(d.orig.y + dy, 0, 1 - f.height) };
        }
        return { ...f, width: clamp(d.orig.width + dx, MIN, 1 - f.x), height: clamp(d.orig.height + dy, MIN, 1 - f.y) };
      }),
    );
    setDirty(true);
  }

  function endDrag() {
    drag.current = null;
  }

  function removeField(key: string) {
    setFields((list) => list.filter((f) => f.key !== key));
    setDirty(true);
  }

  async function save(): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      const payload = fields.map(({ envelopeDocumentId, signerId: sid, type: ft, page, x, y, width, height }) => ({
        envelopeDocumentId,
        signerId: sid,
        type: ft,
        page,
        x: Number(x.toFixed(6)),
        y: Number(y.toFixed(6)),
        width: Number(width.toFixed(6)),
        height: Number(height.toFixed(6)),
      }));
      await api(`/envelopes/${id}/fields`, { method: 'PUT', body: { fields: payload } });
      setDirty(false);
      setNotice(t.fields.saved);
      return true;
    } catch (err) {
      setActionError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const template = templates?.find((tp) => tp.id === templateId);

  function chooseTemplate(tid: string) {
    setTemplateId(tid);
    setIssues(null);
    const tp = templates?.find((x) => x.id === tid);
    // Sugestão inicial: papel N → N-ésimo signatário.
    setRoleSigners(Object.fromEntries((tp?.roles ?? []).map((r, i) => [r.key, env?.signers[i]?.id ?? ''])));
  }

  async function applyTemplate() {
    if (!template) return;
    setBusy(true);
    setActionError(null);
    setIssues(null);
    setNotice(null);
    try {
      const res = await api<{ fields: EnvelopeField[]; anchors: number }>(`/envelopes/${id}/fields/apply-template`, {
        method: 'POST',
        body: { templateId: template.id, roles: template.roles.map((r) => ({ roleKey: r.key, signerId: roleSigners[r.key] })) },
      });
      setFields(res.fields.map((f) => ({ ...f, key: f.id ?? crypto.randomUUID() })));
      setDirty(false);
      setNotice(t.templates.applied(res.fields.length, res.anchors));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TEMPLATE_ANCHORS_MISMATCH' && err.details) {
        const d = err.details as { missing_signature?: string[]; unknown_roles?: string[]; invalid?: Array<{ text: string; page: number }> };
        setIssues({ missingSignature: d.missing_signature ?? [], unknownRoles: d.unknown_roles ?? [], invalid: d.invalid ?? [] });
      } else setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveAndSend() {
    if (!confirmSend) return;
    if (!(await save())) return;
    setBusy(true);
    try {
      await api(`/envelopes/${id}/activate`, { method: 'POST', headers: { 'Idempotency-Key': idemActivate.current }, body: { confirm: true } });
      router.push(`/envelopes/${id}`);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  const overlay = (page: number) =>
    fields
      .filter((f) => f.envelopeDocumentId === docId && f.page === page)
      .map((f) => {
        const color = colorOf(f.signerId);
        return (
          <div
            key={f.key}
            role="group"
            aria-label={`${t.fields.types[f.type]} — ${nameOf(f.signerId)}`}
            onPointerDown={(e) => startDrag(e, f, 'move')}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            className={`absolute flex touch-none items-center justify-center overflow-hidden rounded-sm border-2 text-[10px] font-semibold select-none ${editable ? 'cursor-move' : ''}`}
            style={{
              left: `${f.x * 100}%`,
              top: `${f.y * 100}%`,
              width: `${f.width * 100}%`,
              height: `${f.height * 100}%`,
              borderColor: color,
              backgroundColor: `${color}26`,
              color,
            }}
          >
            <span className="truncate px-1">
              {t.fields.types[f.type]} · {nameOf(f.signerId)}
            </span>
            {editable && (
              <>
                <button
                  type="button"
                  aria-label={t.fields.remove}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => removeField(f.key)}
                  className="absolute top-0 right-0 h-4 w-4 leading-none text-white"
                  style={{ backgroundColor: color }}
                >
                  ×
                </button>
                <span
                  aria-hidden
                  onPointerDown={(e) => startDrag(e, f, 'resize')}
                  onPointerMove={onDrag}
                  onPointerUp={endDrag}
                  className="absolute right-0 bottom-0 h-3 w-3 cursor-se-resize"
                  style={{ backgroundColor: color }}
                />
              </>
            )}
          </div>
        );
      });

  if (env.documents.length === 0 || env.signers.length === 0) {
    return (
      <>
        <PageHeader title={t.fields.title} />
        <Alert tone="warn">{t.fields.noSigners}</Alert>
        <Link href={`/envelopes/${id}`} className="mt-4 inline-block text-brand hover:underline">
          {t.fields.backToEnvelope}
        </Link>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`${t.fields.title} · ${env.title}`}
        actions={
          <Link href={`/envelopes/${id}`} className="text-sm text-brand hover:underline">
            {t.fields.backToEnvelope}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          {editable && templates && (
            <Card title={t.templates.apply}>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted">{t.templates.applyHelp}</p>
                {templates.length === 0 ? (
                  <Link href="/templates" className="text-sm text-brand hover:underline">
                    {t.templates.manage}
                  </Link>
                ) : (
                  <Field label={t.templates.applyTemplate}>
                    {(fid) => (
                      <Select id={fid} value={templateId} onChange={(e) => chooseTemplate(e.target.value)}>
                        <option value="">{t.templates.choose}</option>
                        {templates.map((tp) => (
                          <option key={tp.id} value={tp.id}>
                            {tp.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                {template?.roles.map((r) => (
                  <Field key={r.key} label={t.templates.applyRole(r.label)}>
                    {(fid) => (
                      <Select id={fid} value={roleSigners[r.key] ?? ''} onChange={(e) => setRoleSigners((m) => ({ ...m, [r.key]: e.target.value }))}>
                        <option value="">{t.templates.choose}</option>
                        {env.signers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ))}
                {template && (
                  <>
                    {fields.length > 0 && <p className="text-xs text-muted">{t.templates.applyReplace}</p>}
                    <Button
                      variant="secondary"
                      loading={busy}
                      disabled={template.roles.some((r) => !roleSigners[r.key])}
                      onClick={() => void applyTemplate()}
                    >
                      {t.templates.applyRun}
                    </Button>
                  </>
                )}
                {issues && <AnchorIssuesList issues={issues} labelOf={(k) => template?.roles.find((r) => r.key === k)?.label ?? k} />}
              </div>
            </Card>
          )}
          <Card>
            <div className="flex flex-col gap-4">
              {!editable && <Alert tone="info">{t.fields.readOnly}</Alert>}
              {editable && <p className="text-sm text-muted">{t.fields.help}</p>}
              {env.documents.length > 1 && (
                <Field label={t.fields.document}>
                  {(fid) => (
                    <Select id={fid} value={docId} onChange={(e) => setDocId(e.target.value)}>
                      {env.documents.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.filename}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              {editable && (
                <>
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium">{t.fields.signer}</legend>
                    <div className="flex flex-col gap-2">
                      {env.signers.map((s) => (
                        <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line p-2 text-sm">
                          <input type="radio" name="signer" checked={signerId === s.id} onChange={() => setSignerId(s.id)} className="h-4 w-4" />
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: colorOf(s.id) }} aria-hidden />
                          <span className="truncate">{s.name}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium">{t.fields.type}</legend>
                    <div className="grid grid-cols-2 gap-2">
                      {TYPES.map((ft) => (
                        <button
                          key={ft}
                          type="button"
                          aria-pressed={type === ft}
                          onClick={() => setType(ft)}
                          className={`min-h-11 rounded-lg border px-2 text-sm font-semibold ${type === ft ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-white'}`}
                        >
                          {t.fields.types[ft]}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}
              <p className="text-xs text-muted">{t.fields.count(fields.length)}</p>
              {notice && <Alert tone="ok">{notice}</Alert>}
              {dirty && <Alert tone="warn">{t.fields.unsaved}</Alert>}
              <ErrorMessage error={actionError} />
              {editable && (
                <>
                  <Button onClick={() => void save()} loading={busy} variant="secondary">
                    {t.fields.save}
                  </Button>
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirmSend} onChange={(e) => setConfirmSend(e.target.checked)} />
                    <span>{t.wizard.confirmSend}</span>
                  </label>
                  <Button onClick={() => void saveAndSend()} loading={busy} disabled={!confirmSend}>
                    {t.fields.sendNow}
                  </Button>
                  <p className="text-xs text-muted">{t.fields.optional}</p>
                </>
              )}
            </div>
          </Card>
        </aside>
        <div className="min-w-0">
          {doc && (
            <PdfViewer
              key={doc.id}
              path={`/documents/${doc.documentId}/versions/${doc.versionId}/content?mode=view`}
              title={doc.filename}
              overlay={overlay}
              onPageClick={editable ? addField : undefined}
            />
          )}
        </div>
      </div>
    </>
  );
}
