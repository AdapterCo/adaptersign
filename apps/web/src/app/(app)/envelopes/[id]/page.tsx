'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, downloadFile, newIdempotencyKey } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatDateTime, shortHash } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import type { EnvelopeDetail } from '@/lib/types';
import { useSession } from '@/components/session';
import { Alert, Button, Card, ErrorMessage, Field, PageHeader, Spinner, StatusBadge, Textarea } from '@/components/ui';

interface Timeline {
  chain: { valid: boolean; count: number; headHash: string };
  events: Array<{ id: string; sequence: number; label: string; occurredAt: string; signerName: string | null }>;
}

export default function EnvelopeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: env, error, loading, reload } = useApi<EnvelopeDetail>(`/envelopes/${id}`);
  const { data: timeline, reload: reloadTimeline } = useApi<Timeline>(`/envelopes/${id}/timeline`);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // Enquanto finaliza, atualiza periodicamente.
  useEffect(() => {
    if (!env?.finalizing) return;
    const h = setInterval(() => {
      void reload();
      void reloadTimeline();
    }, 5000);
    return () => clearInterval(h);
  }, [env?.finalizing, reload, reloadTimeline]);

  async function run(fn: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      if (message) setNotice(message);
      await Promise.all([reload(), reloadTimeline()]);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !env) return <Spinner label={t.common.loading} />;
  if (!env) return <ErrorMessage error={error} />;
  const signable = env.status === 'ACTIVE' || env.status === 'PARTIALLY_SIGNED';

  return (
    <>
      <PageHeader
        title={env.title}
        actions={
          <div className="flex flex-wrap gap-2">
            {env.status === 'DRAFT' && (
              <Link href={`/envelopes/new?draft=${env.id}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink">
                {t.envelopes.continueDraft}
              </Link>
            )}
            {(env.status === 'DRAFT' || env.fields.length > 0) && (
              <Link href={`/envelopes/${env.id}/fields`} className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white">
                {t.fields.open}
                {env.fields.length > 0 && ` (${env.fields.length})`}
              </Link>
            )}
            {signable && !env.finalizing && can('envelope:write') && (
              <Button variant="secondary" loading={busy} onClick={() => run(() => api(`/envelopes/${id}/remind`, { method: 'POST', body: {} }), t.envelopes.reminded)}>
                {t.envelopes.remind}
              </Button>
            )}
            {(signable || env.status === 'DRAFT') && !env.finalizing && can('envelope:cancel') && (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                {t.envelopes.cancel}
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm text-muted">
        <StatusBadge status={env.status} />
        {env.externalRef && (
          <span>
            {t.envelopes.externalRef}: <strong className="font-mono text-ink">{env.externalRef}</strong>
          </span>
        )}
        {env.validationCode && (
          <span>
            {t.envelopes.validationCode}: <strong className="font-mono text-ink">{env.validationCode}</strong>
          </span>
        )}
        <span>
          {t.envelopes.createdAt}: {formatDateTime(env.createdAt)}
        </span>
        {env.expiresAt && (
          <span>
            {t.envelopes.expiresAt}: {formatDateTime(env.expiresAt)}
          </span>
        )}
        {env.completedAt && (
          <span>
            {t.envelopes.completedAt}: {formatDateTime(env.completedAt)}
          </span>
        )}
      </div>

      <div className="mb-6 flex flex-col gap-3">
        {env.finalizing && <Alert>{t.envelopes.finalizing}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        <ErrorMessage error={actionError} />
      </div>

      {cancelOpen && (
        <Card className="mb-6" title={t.envelopes.cancel}>
          <p className="mb-3 text-sm text-muted">{t.envelopes.cancelConfirm}</p>
          <Field label={t.envelopes.cancelReason}>{(fid) => <Textarea id={fid} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <div className="mt-4 flex gap-2">
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                run(async () => {
                  await api(`/envelopes/${id}/cancel`, { method: 'POST', body: { reason: reason || undefined }, headers: { 'Idempotency-Key': newIdempotencyKey() } });
                  setCancelOpen(false);
                })
              }
            >
              {t.common.confirm}
            </Button>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card
            title={t.envelopes.documents}
            actions={
              env.evidenceReport && (
                <Button variant="secondary" onClick={() => downloadFile(`/envelopes/${id}/evidence`, 'evidencias.pdf')}>
                  {t.envelopes.downloadEvidence}
                </Button>
              )
            }
          >
            <ul className="divide-y divide-line">
              {env.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium break-all">{d.filename}</p>
                    <p className="font-mono text-xs text-muted" title={d.originalSha256}>
                      {t.envelopes.original}: {shortHash(d.originalSha256)}
                    </p>
                    {d.finalSha256 && (
                      <p className="font-mono text-xs text-muted" title={d.finalSha256}>
                        {t.envelopes.final}: {shortHash(d.finalSha256)}
                      </p>
                    )}
                  </div>
                  {d.finalAvailable && (
                    <Button variant="ghost" onClick={() => downloadFile(`/envelopes/${id}/documents/${d.id}/final`, d.filename)}>
                      {t.envelopes.downloadFinal}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card title={t.envelopes.signers}>
            <ul className="divide-y divide-line">
              {env.signers.map((s) => (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium">
                      {s.name} <span className="text-xs text-muted">· {t.roles[s.role]}</span>
                    </p>
                    <p className="text-sm text-muted">
                      {s.email}
                      {s.phone && ` · ${s.phone}`}
                      {s.cpf && ` · ${s.cpf}`}
                    </p>
                    {s.representing && (
                      <p className="text-xs text-muted">
                        {t.envelopes.representing(s.representing)}
                        {s.externalId && ` · ${t.envelopes.externalId(s.externalId)}`}
                      </p>
                    )}
                    <p className="text-xs text-muted">
                      {env.signingMode === 'SEQUENTIAL' && `${t.envelopes.group(s.signingGroup)} · `}
                      {s.authMethodLabel}
                      {s.signedAt && ` · ${t.envelopes.signedAt} ${formatDateTime(s.signedAt)}`}
                    </p>
                    {s.declineReason && (
                      <p className="text-xs text-bad">
                        {t.envelopes.declineReason}: {s.declineReason}
                      </p>
                    )}
                  </div>
                  <StatusBadge status={s.status} />
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card title={t.envelopes.timeline}>
          {timeline && (
            <>
              <div className="mb-4">
                <Alert tone={timeline.chain.valid ? 'ok' : 'bad'}>{timeline.chain.valid ? t.envelopes.chainOk : t.envelopes.chainBad}</Alert>
              </div>
              <ol className="relative flex flex-col gap-4 border-l border-line pl-4">
                {timeline.events.map((e) => (
                  <li key={e.id}>
                    <p className="text-xs text-muted">{formatDateTime(e.occurredAt)}</p>
                    <p className="text-sm">
                      {e.signerName ? `${e.signerName}: ` : ''}
                      {e.label}
                    </p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
