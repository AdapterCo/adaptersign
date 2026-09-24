'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { Paginated } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { Button, Card, ErrorMessage, Field, Input, PageHeader, Pagination, Select, Spinner, StatusBadge } from '@/components/ui';

interface EnvelopeRow {
  id: string;
  title: string;
  status: string;
  validationCode: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  documentCount: number;
  signerCount: number;
  signedCount: number;
}

const STATUSES = ['DRAFT', 'ACTIVE', 'PARTIALLY_SIGNED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'DECLINED'];

function EnvelopesList() {
  const initialStatus = useSearchParams().get('status') ?? '';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [applied, setApplied] = useState({ search: '', status: initialStatus });
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (applied.search) qs.set('search', applied.search);
  if (applied.status) qs.set('status', applied.status);
  const { data, error, loading } = useApi<Paginated<EnvelopeRow>>(`/envelopes?${qs.toString()}`);

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
          className="mb-4 grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setApplied({ search, status });
          }}
        >
          <div className="sm:col-span-2">
            <Field label={t.common.search}>{(id) => <Input id={id} placeholder={t.envelopes.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
          </div>
          <Field label={t.documents.filterStatus}>
            {(id) => (
              <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">{t.envelopes.allStatus}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t.status[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" variant="secondary" className="self-end">
            {t.common.search}
          </Button>
        </form>
        <ErrorMessage error={error} />
        {loading && <Spinner label={t.common.loading} />}
        {data && data.data.length === 0 && <p className="text-sm text-muted">{t.common.empty}</p>}
        <ul className="divide-y divide-line">
          {data?.data.map((e) => (
            <li key={e.id}>
              <Link href={`/envelopes/${e.id}`} className="flex flex-wrap items-center justify-between gap-3 py-4 hover:text-brand">
                <div>
                  <p className="font-medium">{e.title}</p>
                  <p className="text-xs text-muted">
                    {formatDateTime(e.createdAt)} · {e.documentCount} {t.envelopes.documents.toLowerCase()} · {t.dashboard.signedOf(e.signedCount, e.signerCount)}
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
