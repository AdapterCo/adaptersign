'use client';

import { useState } from 'react';
import { api, type Paginated } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/components/session';
import { Alert, Button, Card, ErrorMessage, PageHeader, Pagination, Select, Spinner } from '@/components/ui';

interface Metrics {
  organizations: number;
  users: number;
  envelopes: Record<string, number>;
  signatures: number;
  storageBytes: string;
  webhookDeliveries: Record<string, number>;
  notificationsFailed: number;
  outboxPending: number;
  queues: Record<string, Record<string, number>>;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  subscription: { status: string; plan: { code: string } } | null;
  _count: { members: number; envelopes: number };
}

export default function AdminPage() {
  const { me } = useSession();
  const [page, setPage] = useState(1);
  const metrics = useApi<Metrics>(me?.user.isPlatformAdmin ? '/admin/metrics' : null);
  const orgs = useApi<Paginated<OrgRow>>(me?.user.isPlatformAdmin ? `/admin/organizations?page=${page}` : null);
  const plans = useApi<Array<{ id: string; code: string; name: string }>>(me?.user.isPlatformAdmin ? '/admin/plans' : null);
  const failures = useApi<Paginated<{ id: string; eventType: string; status: string; attempts: number; lastError: string | null; updatedAt: string }>>(
    me?.user.isPlatformAdmin ? '/admin/webhooks/failures' : null,
  );
  const [error, setError] = useState<unknown>(null);

  if (!me?.user.isPlatformAdmin) return <Alert tone="bad">{t.common.errorGeneric}</Alert>;

  async function setPlan(orgId: string, planCode: string) {
    setError(null);
    try {
      await api(`/admin/organizations/${orgId}/subscription`, { method: 'PUT', body: { planCode, status: 'ACTIVE' } });
      await orgs.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <PageHeader title={t.admin.title} />
      <div className="mb-6">
        <Alert>{t.admin.notice}</Alert>
      </div>
      <ErrorMessage error={error} />
      <div className="flex flex-col gap-6">
        <Card title={t.admin.metrics}>
          {metrics.loading && <Spinner label={t.common.loading} />}
          {metrics.data && (
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted">{t.admin.organizations}</dt>
                <dd className="text-2xl font-bold">{metrics.data.organizations}</dd>
              </div>
              <div>
                <dt className="text-muted">Usuários</dt>
                <dd className="text-2xl font-bold">{metrics.data.users}</dd>
              </div>
              <div>
                <dt className="text-muted">Assinaturas</dt>
                <dd className="text-2xl font-bold">{metrics.data.signatures}</dd>
              </div>
              <div>
                <dt className="text-muted">{t.dashboard.storage}</dt>
                <dd className="text-2xl font-bold">{formatBytes(metrics.data.storageBytes)}</dd>
              </div>
              <div className="col-span-2 sm:col-span-4">
                <dt className="text-muted">{t.admin.queues}</dt>
                <dd className="mt-1 grid gap-1 font-mono text-xs sm:grid-cols-2">
                  {Object.entries(metrics.data.queues).map(([q, c]) => (
                    <span key={q}>
                      {q}: {Object.entries(c)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' ')}
                    </span>
                  ))}
                  <span>outbox pendente: {metrics.data.outboxPending}</span>
                  <span>e-mails com falha: {metrics.data.notificationsFailed}</span>
                </dd>
              </div>
            </dl>
          )}
        </Card>

        <Card title={t.admin.organizations}>
          <ul className="divide-y divide-line text-sm">
            {orgs.data?.data.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{o.name}</p>
                  <p className="text-xs text-muted">
                    {o.slug} · {o._count.members} membros · {o._count.envelopes} envelopes · {formatDateTime(o.createdAt)}
                  </p>
                </div>
                <label className="flex items-center gap-2">
                  <span className="sr-only">{t.admin.setPlan}</span>
                  <Select className="w-44" value={o.subscription?.plan.code ?? ''} onChange={(e) => void setPlan(o.id, e.target.value)}>
                    <option value="">—</option>
                    {plans.data?.map((p) => (
                      <option key={p.id} value={p.code}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </li>
            ))}
          </ul>
          {orgs.data && <Pagination page={orgs.data.pagination.page} totalPages={orgs.data.pagination.totalPages} onChange={setPage} />}
        </Card>

        <Card title={t.admin.failures}>
          <ul className="divide-y divide-line text-sm">
            {failures.data?.data.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-mono text-xs">
                    {f.eventType} · {f.status} · {f.attempts} tentativas
                  </p>
                  <p className="text-xs text-muted">
                    {f.lastError} · {formatDateTime(f.updatedAt)}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => void api(`/admin/webhooks/deliveries/${f.id}/retry`, { method: 'POST' }).then(failures.reload).catch(setError)}>
                  Reenviar
                </Button>
              </li>
            ))}
          </ul>
          {failures.data?.data.length === 0 && <p className="text-sm text-muted">{t.common.empty}</p>}
        </Card>
      </div>
    </>
  );
}
