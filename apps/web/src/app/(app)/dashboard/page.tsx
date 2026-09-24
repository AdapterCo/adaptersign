'use client';

import Link from 'next/link';
import { t } from '@/lib/i18n';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { Card, ErrorMessage, PageHeader, Spinner, StatusBadge } from '@/components/ui';

interface Dashboard {
  counts: Record<string, number> & { awaitingSignature: number };
  recent: Array<{ id: string; title: string; status: string; updatedAt: string; signerCount: number; signedCount: number }>;
  plan: { code: string; name: string; monthlyEnvelopes: number | null; monthlyDocuments: number | null; storageLimitBytes: string | null };
  usage: Record<string, string>;
}

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="rounded-xl border border-line bg-white p-5 shadow-sm hover:border-brand">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-3xl font-bold">{value}</p>
    </Link>
  );
}

function UsageBar({ label, used, limit, format = (n: number) => String(n) }: { label: string; used: number; limit: number | null; format?: (n: number) => string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted">
          {format(used)} / {limit === null ? t.dashboard.unlimited : format(limit)}
        </span>
      </div>
      {limit !== null && (
        <div className="mt-1 h-2 rounded-full bg-canvas" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={`h-2 rounded-full ${pct >= 90 ? 'bg-bad' : 'bg-brand'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { data, error, loading } = useApi<Dashboard>('/dashboard');
  return (
    <>
      <PageHeader
        title={t.dashboard.title}
        actions={
          <Link href="/envelopes/new" className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark">
            {t.dashboard.newEnvelope}
          </Link>
        }
      />
      <ErrorMessage error={error} />
      {loading && <Spinner label={t.common.loading} />}
      {data && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label={t.dashboard.awaiting} value={data.counts.awaitingSignature} href="/envelopes?status=ACTIVE" />
            <Stat label={t.dashboard.completed} value={data.counts.COMPLETED} href="/envelopes?status=COMPLETED" />
            <Stat label={t.dashboard.drafts} value={data.counts.DRAFT} href="/envelopes?status=DRAFT" />
            <Stat label={t.dashboard.expired} value={data.counts.EXPIRED} href="/envelopes?status=EXPIRED" />
            <Stat label={t.dashboard.cancelled} value={data.counts.CANCELLED} href="/envelopes?status=CANCELLED" />
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card title={t.dashboard.recent} className="lg:col-span-2">
              {data.recent.length === 0 ? (
                <p className="text-sm text-muted">{t.common.empty}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.recent.map((e) => (
                    <li key={e.id}>
                      <Link href={`/envelopes/${e.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:text-brand">
                        <span className="font-medium">{e.title}</span>
                        <span className="flex items-center gap-3 text-sm text-muted">
                          {t.dashboard.signedOf(e.signedCount, e.signerCount)}
                          <StatusBadge status={e.status} />
                          <span className="hidden sm:inline">{formatDateTime(e.updatedAt)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={`${t.dashboard.usage} · ${data.plan.name}`}>
              <div className="flex flex-col gap-4">
                <UsageBar label={t.dashboard.envelopesMonth} used={Number(data.usage.ENVELOPES_CREATED)} limit={data.plan.monthlyEnvelopes} />
                <UsageBar label={t.dashboard.documentsMonth} used={Number(data.usage.DOCUMENTS_UPLOADED)} limit={data.plan.monthlyDocuments} />
                <UsageBar
                  label={t.dashboard.storage}
                  used={Number(data.usage.STORAGE_BYTES)}
                  limit={data.plan.storageLimitBytes === null ? null : Number(data.plan.storageLimitBytes)}
                  format={formatBytes}
                />
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
