'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { branding } from '@/lib/branding';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { Alert, Button, Card, ErrorMessage, Field, Input } from '@/components/ui';

interface Report {
  found: true;
  matchType?: string;
  integrity: 'VERIFIED' | 'NOT_CONFIRMED' | null;
  envelope: { title: string; validationCode: string; status: string; organizationName: string; completedAt: string | null };
  documents: Array<{ filename: string; originalSha256: string; finalSha256: string | null; integrity: string }>;
  evidence: { sha256: string; integrity: string } | null;
  chain: { valid: boolean; events: number } | null;
  signers: Array<{ name: string; email: string; role: string; authentication: string; signedAt: string }>;
}

type Result = { found: false; sha256?: string } | Report | { found: true; sha256: string; results: Report[] };

function ReportView({ r }: { r: Report }) {
  return (
    <Card>
      {r.matchType && <p className="mb-2 text-xs font-semibold text-muted uppercase">{t.verify.matchType[r.matchType] ?? r.matchType}</p>}
      {r.integrity === null ? (
        <Alert tone="warn">{t.verify.inProgress}</Alert>
      ) : (
        <Alert tone={r.integrity === 'VERIFIED' ? 'ok' : 'bad'}>
          <strong className="text-base">{r.integrity === 'VERIFIED' ? t.verify.integrityOk : t.verify.integrityBad}</strong>
        </Alert>
      )}
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">{t.verify.envelope}</dt>
          <dd className="font-medium">{r.envelope.title}</dd>
        </div>
        <div>
          <dt className="text-muted">{t.envelopes.validationCode}</dt>
          <dd className="font-mono">{r.envelope.validationCode}</dd>
        </div>
        <div>
          <dt className="text-muted">{t.verify.sender}</dt>
          <dd>{r.envelope.organizationName}</dd>
        </div>
        <div>
          <dt className="text-muted">{t.verify.finishedAt}</dt>
          <dd>{formatDateTime(r.envelope.completedAt)}</dd>
        </div>
      </dl>
      {r.documents.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2 text-sm">
          {r.documents.map((d) => (
            <li key={d.originalSha256} className="rounded-lg border border-line p-3">
              <p className="font-medium break-all">{d.filename}</p>
              <p className="font-mono text-xs break-all text-muted">
                {t.envelopes.original}: {d.originalSha256}
              </p>
              {d.finalSha256 && (
                <p className="font-mono text-xs break-all text-muted">
                  {t.envelopes.final}: {d.finalSha256}
                </p>
              )}
              <p className={`mt-1 text-xs font-semibold ${d.integrity === 'VERIFIED' ? 'text-ok' : 'text-bad'}`}>
                {d.integrity === 'VERIFIED' ? t.verify.integrityOk : t.verify.integrityBad}
              </p>
            </li>
          ))}
        </ul>
      )}
      {r.signers.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 text-sm font-semibold">{t.verify.signers}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {r.signers.map((s, i) => (
              <li key={i}>
                {s.name} ({s.email}) — {t.roles[s.role]} · {s.authentication} · {formatDateTime(s.signedAt)}
              </li>
            ))}
          </ul>
        </>
      )}
      {r.chain && (
        <p className={`mt-4 text-sm ${r.chain.valid ? 'text-ok' : 'text-bad'}`}>
          {t.verify.chain}: {r.chain.valid ? t.verify.integrityOk : t.verify.integrityBad} · {t.verify.events(r.chain.events)}
        </p>
      )}
    </Card>
  );
}

export default function VerifyPage() {
  const [code, setCode] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function run(fn: () => Promise<Result>) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await fn());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function byCode(e: FormEvent) {
    e.preventDefault();
    void run(() => api<Result>(`/verify/${encodeURIComponent(code.trim())}`, { noRefresh: true }));
  }

  function byFile(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    void run(() => api<Result>('/verify/file', { method: 'POST', form, noRefresh: true }));
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <div>
        <Link href="/" className="font-bold text-brand">
          {branding.name}
        </Link>
        <h1 className="mt-4 text-2xl font-bold">{t.verify.title}</h1>
        <p className="text-sm text-muted">{t.verify.subtitle}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t.verify.byCode}>
          <form onSubmit={byCode} className="flex flex-col gap-3">
            <Field label={t.envelopes.validationCode}>
              {(id) => <Input id={id} placeholder={t.verify.codePlaceholder} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono uppercase" />}
            </Field>
            <Button type="submit" loading={busy} disabled={code.trim().length < 10}>
              {t.verify.check}
            </Button>
          </form>
        </Card>
        <Card title={t.verify.byFile}>
          <form onSubmit={byFile} className="flex flex-col gap-3">
            <Field label="PDF" hint={t.verify.fileHint}>
              {(id, d) => <Input id={id} aria-describedby={d} ref={fileRef} type="file" accept="application/pdf,.pdf" required />}
            </Field>
            <Button type="submit" loading={busy}>
              {t.verify.check}
            </Button>
          </form>
        </Card>
      </div>
      <ErrorMessage error={error} />
      {result && !result.found && (
        <Alert tone="bad">
          {t.verify.notFound}
          {'sha256' in result && result.sha256 && <span className="mt-1 block font-mono text-xs break-all">{result.sha256}</span>}
        </Alert>
      )}
      {result && result.found && 'results' in result && (
        <>
          <p className="text-xs break-all text-muted">
            {t.verify.computedHash}: <span className="font-mono">{result.sha256}</span>
          </p>
          {result.results.map((r, i) => (
            <ReportView key={i} r={r} />
          ))}
        </>
      )}
      {result && result.found && !('results' in result) && <ReportView r={result} />}
    </main>
  );
}
