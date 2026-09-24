'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Alert, Button, ErrorMessage, Field, Input, Spinner } from '@/components/ui';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const invite = params.get('invite') === '1';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/auth/password/reset', { method: 'POST', body: { token, password }, noRefresh: true });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold">{invite ? t.auth.inviteTitle : t.auth.resetTitle}</h1>
      {done ? (
        <>
          <Alert tone="ok">{t.auth.resetDone}</Alert>
          <Link href="/login" className="mt-6 inline-block font-semibold text-brand hover:underline">
            {t.auth.login}
          </Link>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t.auth.newPassword} hint={t.auth.passwordHint}>
            {(id, d) => <Input id={id} aria-describedby={d} type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <ErrorMessage error={error} />
          <Button type="submit" loading={loading} disabled={!token}>
            {t.common.save}
          </Button>
        </form>
      )}
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Spinner label={t.common.loading} />}>
      <ResetForm />
    </Suspense>
  );
}
