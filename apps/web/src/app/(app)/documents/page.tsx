'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { api, downloadFile, type Paginated } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatBytes, formatDateTime, shortHash } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import type { DocumentRow } from '@/lib/types';
import { useSession } from '@/components/session';
import { Button, Card, ErrorMessage, Field, Input, PageHeader, Pagination, Select, Spinner, StatusBadge } from '@/components/ui';

export default function DocumentsPage() {
  const { can } = useSession();
  const [filters, setFilters] = useState({ search: '', status: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (applied.search) qs.set('search', applied.search);
  if (applied.status) qs.set('status', applied.status);
  if (applied.from) qs.set('from', new Date(applied.from).toISOString());
  if (applied.to) qs.set('to', new Date(`${applied.to}T23:59:59`).toISOString());
  const { data, error, loading, reload } = useApi<Paginated<DocumentRow>>(`/documents?${qs.toString()}`);

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);

  async function upload(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setUploading(true);
    setUploadError(null);
    try {
      await api('/documents', { method: 'POST', form });
      if (fileRef.current) fileRef.current.value = '';
      await reload();
    } catch (err) {
      setUploadError(err);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <PageHeader title={t.documents.title} />
      {can('document:write') && (
        <Card className="mb-6">
          <form onSubmit={upload} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label={t.documents.upload} hint={t.documents.uploadHint}>
                {(id, d) => <Input id={id} aria-describedby={d} ref={fileRef} type="file" accept="application/pdf,.pdf" required />}
              </Field>
            </div>
            <Button type="submit" loading={uploading}>
              {uploading ? t.documents.uploading : t.documents.upload}
            </Button>
          </form>
          <div className="mt-3">
            <ErrorMessage error={uploadError} />
          </div>
        </Card>
      )}

      <Card>
        <form
          className="mb-4 grid gap-3 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setApplied(filters);
          }}
        >
          <div className="sm:col-span-2">
            <Field label={t.common.search}>{(id) => <Input id={id} value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />}</Field>
          </div>
          <Field label={t.documents.filterStatus}>
            {(id) => (
              <Select id={id} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                <option value="">{t.documents.filterAll}</option>
                <option value="ACTIVE">{t.documents.active}</option>
                <option value="LOCKED">{t.documents.locked}</option>
              </Select>
            )}
          </Field>
          <Field label={t.documents.from}>{(id) => <Input id={id} type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />}</Field>
          <Field label={t.documents.to}>{(id) => <Input id={id} type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />}</Field>
          <Button type="submit" variant="secondary" className="sm:col-span-5 sm:justify-self-end">
            {t.common.search}
          </Button>
        </form>

        <ErrorMessage error={error} />
        {loading && <Spinner label={t.common.loading} />}
        {data && data.data.length === 0 && <p className="text-sm text-muted">{t.common.empty}</p>}
        {data && data.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="py-2 pr-4">{t.documents.name}</th>
                  <th className="py-2 pr-4">{t.documents.created}</th>
                  <th className="py-2 pr-4">{t.documents.status}</th>
                  <th className="py-2 pr-4">{t.documents.hash}</th>
                  <th className="py-2 pr-4">{t.documents.envelopes}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.data.map((d) => (
                  <tr key={d.id}>
                    <td className="py-3 pr-4">
                      <p className="font-medium">{d.title}</p>
                      <p className="text-xs text-muted">
                        {d.latestVersion?.pageCount} {t.documents.pages.toLowerCase()} · {formatBytes(d.latestVersion?.sizeBytes)} · v{d.latestVersion?.versionNumber}
                      </p>
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap">{formatDateTime(d.createdAt)}</td>
                    <td className="py-3 pr-4">{d.status === 'LOCKED' ? t.documents.locked : t.documents.active}</td>
                    <td className="py-3 pr-4 font-mono text-xs" title={d.latestVersion?.sha256}>
                      {shortHash(d.latestVersion?.sha256)}
                    </td>
                    <td className="py-3 pr-4">
                      <ul className="flex flex-col gap-1">
                        {d.envelopes.map((e) => (
                          <li key={e.id} className="flex items-center gap-2">
                            <Link href={`/envelopes/${e.id}`} className="text-brand hover:underline">
                              {e.title}
                            </Link>
                            <StatusBadge status={e.status} />
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="py-3 text-right">
                      {d.latestVersion && (
                        <Button variant="ghost" onClick={() => downloadFile(`/documents/${d.id}/versions/${d.latestVersion!.id}/content?mode=download`, d.originalFilename)}>
                          {t.common.download}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={data.pagination.page} totalPages={data.pagination.totalPages} onChange={setPage} />}
      </Card>
    </>
  );
}
