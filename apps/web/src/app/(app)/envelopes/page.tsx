'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { Paginated } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import type { Template } from '@/lib/types';
import { useSession } from '@/components/session';
import { Button, Card, ErrorMessage, Field, Input, PageHeader, Pagination, Select, Spinner, StatusBadge } from '@/components/ui';

interface EnvelopeRow {
  id: string;
  title: string;
  status: string;
  validationCode: string | null;
  externalRef: string | null;
  origin: 'integration' | 'manual';
  template: { id: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  documentCount: number;
  signerCount: number;
  signedCount: number;
}

const STATUSES = ['DRAFT', 'ACTIVE', 'PARTIALLY_SIGNED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'DECLINED'];
// Filtros aceitos pela API (também lidos da URL, ex.: /envelopes?sameCpfAs=<signatário>).
const FILTER_KEYS = ['search', 'status', 'origin', 'templateId', 'cpf', 'externalRef', 'representative', 'from', 'to', 'sameCpfAs'] as const;
type Filters = Record<(typeof FILTER_KEYS)[number], string>;

/** "2026-09-01" (campo de data) → início/fim do dia no fuso do navegador, em ISO. */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

function EnvelopesList() {
  const params = useSearchParams();
  const { can } = useSession();
  const initial = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Filters;
  const [draft, setDraft] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);
  const [more, setMore] = useState(FILTER_KEYS.some((k) => !['search', 'status'].includes(k) && initial[k]));
  const [page, setPage] = useState(1);
  const { data: templates } = useApi<Template[]>(can('template:read') ? '/templates' : null);

  const qs = new URLSearchParams({ page: String(page), pageSize: '20' });
  for (const k of FILTER_KEYS) {
    const v = applied[k].trim();
    if (!v) continue;
    qs.set(k, k === 'from' ? dayStart(v) : k === 'to' ? dayEnd(v) : v);
  }
  const { data, error, loading } = useApi<Paginated<EnvelopeRow>>(`/envelopes?${qs.toString()}`);
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((f) => ({ ...f, [k]: e.target.value }));
  const active = FILTER_KEYS.filter((k) => applied[k]).length;

  return (
    <>
      <PageHeader
        title={t.envelopes.title}
        actions={
          <Link href="/envelopes/new" className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark">
            {t.envelopes.new}
          </Link>
        }
      />
      <Card>
        <form
          className="mb-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setApplied(draft);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <Field label={t.common.search}>{(id) => <Input id={id} placeholder={t.envelopes.searchPlaceholder} value={draft.search} onChange={set('search')} />}</Field>
            </div>
            <Field label={t.documents.filterStatus}>
              {(id) => (
                <Select id={id} value={draft.status} onChange={set('status')}>
                  <option value="">{t.envelopes.allStatus}</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t.status[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t.envelopes.filters.origin}>
              {(id) => (
                <Select id={id} value={draft.origin} onChange={set('origin')}>
                  <option value="">{t.envelopes.filters.anyOrigin}</option>
                  <option value="integration">{t.envelopes.filters.integration}</option>
                  <option value="manual">{t.envelopes.filters.manual}</option>
                </Select>
              )}
            </Field>
          </div>
          {more && (
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label={t.envelopes.filters.cpf}>{(id) => <Input id={id} inputMode="numeric" placeholder="000.000.000-00" value={draft.cpf} onChange={set('cpf')} />}</Field>
              <Field label={t.envelopes.externalRef}>{(id) => <Input id={id} value={draft.externalRef} onChange={set('externalRef')} />}</Field>
              {templates && (
                <Field label={t.envelopes.filters.template}>
                  {(id) => (
                    <Select id={id} value={draft.templateId} onChange={set('templateId')}>
                      <option value="">{t.envelopes.filters.anyTemplate}</option>
                      {templates.map((tp) => (
                        <option key={tp.id} value={tp.id}>
                          {tp.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label={t.envelopes.filters.representative}>{(id) => <Input id={id} value={draft.representative} onChange={set('representative')} />}</Field>
              <Field label={t.envelopes.filters.from}>{(id) => <Input id={id} type="date" value={draft.from} onChange={set('from')} />}</Field>
              <Field label={t.envelopes.filters.to}>{(id) => <Input id={id} type="date" value={draft.to} onChange={set('to')} />}</Field>
            </div>
          )}
          {applied.sameCpfAs && <p className="text-sm text-muted">{t.envelopes.filters.sameCpfActive}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary">
              {t.common.search}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMore((m) => !m)}>
              {more ? t.envelopes.filters.less : t.envelopes.filters.more}
            </Button>
            {active > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  const empty = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as Filters;
                  setDraft(empty);
                  setApplied(empty);
                  setPage(1);
                }}
              >
                {t.envelopes.filters.clear(active)}
              </Button>
            )}
          </div>
        </form>
        <ErrorMessage error={error} />
        {loading && <Spinner label={t.common.loading} />}
        {data && data.data.length === 0 && <p className="text-sm text-muted">{t.common.empty}</p>}
        {data && data.pagination.total > 0 && <p className="mb-2 text-xs text-muted">{t.envelopes.filters.total(data.pagination.total)}</p>}
        <ul className="divide-y divide-line">
          {data?.data.map((e) => (
            <li key={e.id}>
              <Link href={`/envelopes/${e.id}`} className="flex flex-wrap items-center justify-between gap-3 py-4 hover:text-brand">
                <div className="min-w-0">
                  <p className="font-medium">
                    {e.title}
                    {e.origin === 'integration' && (
                      <span className="ml-2 rounded bg-brand-soft px-1.5 py-0.5 align-middle text-[10px] font-semibold text-brand">{t.envelopes.filters.integration}</span>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDateTime(e.createdAt)} · {e.documentCount} {t.envelopes.documents.toLowerCase()} · {t.dashboard.signedOf(e.signedCount, e.signerCount)}
                    {e.externalRef && ` · ${t.envelopes.externalRef}: ${e.externalRef}`}
                    {e.template && ` · ${e.template.name}`}
                    {e.validationCode && ` · ${e.validationCode}`}
                  </p>
                </div>
                <StatusBadge status={e.status} />
              </Link>
            </li>
          ))}
        </ul>
        {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} onChange={setPage} />}
      </Card>
    </>
  );
}

export default function EnvelopesPage() {
  return (
    <Suspense fallback={<Spinner label={t.common.loading} />}>
      <EnvelopesList />
    </Suspense>
  );
}
