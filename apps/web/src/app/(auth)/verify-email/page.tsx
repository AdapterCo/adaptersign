'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Alert, ErrorMessage, Spinner } from '@/components/ui';

function Confirm() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'pending' | 'ok' | 'error'>('pending');
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api('/auth/verify-email/confirm', { method: 'POST', body: { token }, noRefresh: true })
      .then(() => setState('ok'))
      .catch((err) => {
        setError(err);
        setState('error');
      });
  }, [token]);

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold">{t.auth.verifyTitle}</h1>
      {state === 'pending' && <Spinner label={t.auth.verifyPending} />}
      {state === 'ok' && <Alert tone="ok">{t.auth.verifyOk}</Alert>}
      {state === 'error' && <ErrorMessage error={error} />}
      <Link href="/dashboard" className="mt-6 inline-block text-brand hover:underline">
        {t.nav.dashboard}
      </Link>
    </>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<Spinner label={t.common.loading} />}>
      <Confirm />
    </Suspense>
  );
}
