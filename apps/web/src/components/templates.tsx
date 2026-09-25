'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import type { AnchorIssues, PageCorner, Template, TemplateRole, TemplateTestResult } from '@/lib/types';
import { useSession } from './session';
import { PdfViewer } from './pdf-viewer';
import { Alert, Button, Card, ErrorMessage, Field, Input, Select, Textarea } from './ui';

export const ROLE_COLORS = ['#1F4FD1', '#0A7A48', '#A15C00', '#B42318', '#6B21A8', '#0E7490'];
const CORNERS: PageCorner[] = ['BOTTOM_RIGHT', 'BOTTOM_LEFT', 'TOP_RIGHT', 'TOP_LEFT'];

/** "Contrato de Moto" → "contrato-de-moto" */
export function slugify(text: string, max = 60): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

const anchor = (type: string, role: string) => `[[AS:${type}:${role}]]`;

function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={t.templates.copy}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded border border-line bg-canvas px-2 py-1 font-mono text-xs hover:border-brand"
    >
      {copied ? t.templates.copied : text}
    </button>
  );
}

/** Lista de pendências entre o PDF e o modelo. */
export function AnchorIssuesList({ issues, labelOf }: { issues: AnchorIssues; labelOf?: (key: string) => string }) {
  const name = (k: string) => (labelOf ? `${labelOf(k)} (${k})` : k);
  return (
    <Alert tone="warn">
      <p className="font-semibold">{t.templates.testIssues}</p>
      <ul className="mt-1 list-disc pl-5">
        {issues.missingSignature.length > 0 && (
          <li>
            {t.templates.missingSignature}: {issues.missingSignature.map(name).join(', ')}
          </li>
        )}
        {issues.unknownRoles.length > 0 && (
          <li>
            {t.templates.unknownRoles}: {issues.unknownRoles.join(', ')}
          </li>
        )}
        {issues.invalid.length > 0 && (
          <li>
            {t.templates.invalid}: {issues.invalid.map((i) => `${i.text} (${t.templates.page(i.page)})`).join(', ')}
          </li>
        )}
      </ul>
    </Alert>
  );
}

const newRole = (label: string, key: string, signingGroup: number, isCompany = false): TemplateRole => ({
  key,
  label,
  signingGroup,
  isCompany,
  initialsAllPages: false,
  initialsCorner: 'BOTTOM_RIGHT',
});

/** Cadastro/edição de modelo (papéis + marcadores). */
export function TemplateEditor({ initial, onSaved }: { initial?: Template; onSaved?: (tpl: Template) => void }) {
  const router = useRouter();
  const { can } = useSession();
  const writable = can('template:write');
  const [name, setName] = useState(initial?.name ?? '');
  const [key, setKey] = useState(initial?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(!!initial);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [mode, setMode] = useState<Template['signingMode']>(initial?.signingMode ?? 'SEQUENTIAL');
  const [roles, setRoles] = useState<TemplateRole[]>(initial?.roles ?? [newRole('Loja', 'loja', 1, true), newRole('Cliente', 'cliente', 2)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const setRole = (i: number, patch: Partial<TemplateRole>) => setRoles((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = { key, name, description: description || undefined, signingMode: mode, roles };
      const saved = initial
        ? await api<Template>(`/templates/${initial.id}`, { method: 'PUT', body })
        : await api<Template>('/templates', { method: 'POST', body });
      setNotice(t.templates.saved);
      if (!initial) router.replace(`/templates/${saved.id}`);
      onSaved?.(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!initial) return;
    setBusy(true);
    try {
      await api(`/templates/${initial.id}`, { method: 'DELETE' });
      router.replace('/templates');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <fieldset disabled={!writable} className="grid gap-4 md:grid-cols-2">
          <Field label={t.templates.name}>
            {(fid) => (
              <Input
                id={fid}
                value={name}
                maxLength={120}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!keyTouched) setKey(slugify(e.target.value));
                }}
              />
            )}
          </Field>
          <Field label={t.templates.key} hint={t.templates.keyHint}>
            {(fid) => (
              <Input
                id={fid}
                value={key}
                maxLength={60}
                className="font-mono"
                onChange={(e) => {
                  setKeyTouched(true);
                  setKey(e.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
          <div className="md:col-span-2">
            <Field label={t.templates.description}>
              {(fid) => <Textarea id={fid} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
          </div>
          <Field label={t.templates.signingMode}>
            {(fid) => (
              <Select id={fid} value={mode} onChange={(e) => setMode(e.target.value as Template['signingMode'])}>
                <option value="SEQUENTIAL">{t.templates.sequential}</option>
                <option value="PARALLEL">{t.templates.parallel}</option>
              </Select>
            )}
          </Field>
        </fieldset>
      </Card>

      <Card
        title={t.templates.roles}
        actions={
          writable &&
          roles.length < 10 && (
            <Button variant="secondary" onClick={() => setRoles((list) => [...list, newRole('', '', list.length + 1)])}>
              {t.templates.addRole}
            </Button>
          )
        }
      >
        <fieldset disabled={!writable} className="flex flex-col gap-4">
          {roles.map((r, i) => (
            <div key={i} className="rounded-lg border border-line p-4" style={{ borderLeft: `4px solid ${ROLE_COLORS[i % ROLE_COLORS.length]}` }}>
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_90px]">
                <Field label={t.templates.roleLabel}>
                  {(fid) => (
                    <Input
                      id={fid}
                      value={r.label}
                      maxLength={60}
                      onChange={(e) => setRole(i, { label: e.target.value, ...(initial?.roles[i]?.key ? {} : { key: slugify(e.target.value, 40) }) })}
                    />
                  )}
                </Field>
                <Field label={t.templates.roleKey}>
                  {(fid) => <Input id={fid} value={r.key} maxLength={40} className="font-mono" onChange={(e) => setRole(i, { key: e.target.value.toLowerCase() })} />}
                </Field>
                {mode === 'SEQUENTIAL' && (
                  <Field label={t.templates.roleGroup}>
                    {(fid) => (
                      <Input id={fid} type="number" min={1} max={20} value={r.signingGroup} onChange={(e) => setRole(i, { signingGroup: Number(e.target.value) || 1 })} />
                    )}
                  </Field>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={r.isCompany} onChange={(e) => setRole(i, { isCompany: e.target.checked })} />
                  {t.templates.isCompany}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={r.initialsAllPages} onChange={(e) => setRole(i, { initialsAllPages: e.target.checked })} />
                  {t.templates.initialsAllPages}
                </label>
                {r.initialsAllPages && (
                  <Select aria-label={t.templates.corner} value={r.initialsCorner} onChange={(e) => setRole(i, { initialsCorner: e.target.value as PageCorner })} className="w-auto">
                    {CORNERS.map((c) => (
                      <option key={c} value={c}>
                        {t.templates.corners[c]}
                      </option>
                    ))}
                  </Select>
                )}
                {writable && roles.length > 1 && (
                  <button type="button" className="ml-auto text-sm text-bad hover:underline" onClick={() => setRoles((list) => list.filter((_, j) => j !== i))}>
                    {t.templates.removeRole}
                  </button>
                )}
              </div>
              {r.key && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <CopyChip text={anchor('assinatura', r.key)} />
                  <span className="text-xs text-muted">{t.templates.anchorsOptional}</span>
                  <CopyChip text={anchor('rubrica', r.key)} />
                  <CopyChip text={anchor('nome', r.key)} />
                  <CopyChip text={anchor('data', r.key)} />
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-muted">{t.templates.anchorsHelp}</p>
        </fieldset>
      </Card>

      {notice && <Alert tone="ok">{notice}</Alert>}
      <ErrorMessage error={error} />
      {writable && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} loading={busy}>
            {t.templates.save}
          </Button>
          {initial && !confirmArchive && (
            <Button variant="danger" onClick={() => setConfirmArchive(true)}>
              {t.templates.archive}
            </Button>
          )}
        </div>
      )}
      {confirmArchive && (
        <Card>
          <p className="mb-3 text-sm text-muted">{t.templates.archiveConfirm}</p>
          <div className="flex gap-2">
            <Button variant="danger" loading={busy} onClick={() => void archive()}>
              {t.common.confirm}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmArchive(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

/** Testa um PDF de exemplo contra o modelo e mostra onde os campos cairão. */
export function TemplateTester({ template }: { template: Template }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<TemplateTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const roleIndex = (k: string) => Math.max(0, template.roles.findIndex((r) => r.key === k));
  const labelOf = (k: string) => template.roles.find((r) => r.key === k)?.label ?? k;

  async function run() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      setResult(await api<TemplateTestResult>(`/templates/${template.id}/test`, { method: 'POST', form }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const overlay = (page: number) =>
    result?.fields
      .filter((f) => f.page === page)
      .map((f, i) => {
        const color = ROLE_COLORS[roleIndex(f.role) % ROLE_COLORS.length];
        return (
          <div
            key={i}
            className="absolute flex items-center justify-center overflow-hidden rounded-sm border-2 text-[10px] font-semibold"
            style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%`, borderColor: color, backgroundColor: `${color}26`, color }}
          >
            <span className="truncate px-1">
              {t.fields.types[f.type]} · {labelOf(f.role)}
            </span>
          </div>
        );
      });

  return (
    <Card title={t.templates.testTitle}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t.templates.testHelp}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t.templates.testFile}>
            {(fid) => (
              <Input
                id={fid}
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setResult(null);
                }}
              />
            )}
          </Field>
          <Button onClick={() => void run()} loading={busy} disabled={!file}>
            {t.templates.testRun}
          </Button>
        </div>
        <ErrorMessage error={error} />
        {result && (result.ok ? <Alert tone="ok">{t.templates.testOk(result.anchors.length, result.fields.length)}</Alert> : <AnchorIssuesList issues={result} labelOf={labelOf} />)}
        {result && file && <PdfViewer file={file} title={file.name} overlay={overlay} />}
      </div>
    </Card>
  );
}
