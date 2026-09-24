'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button, ErrorMessage, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password }, noRefresh: true });
      router.replace('/dashboard');
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold">{t.auth.loginTitle}</h1>
      <p className="mt-1 mb-6 text-sm text-muted">{t.auth.loginSubtitle}</p>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label={t.auth.email}>
          {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label={t.auth.password}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        <ErrorMessage error={error} />
        <Button type="submit" loading={loading}>
          {t.auth.login}
        </Button>
      </form>
      <div className="mt-6 flex flex-col gap-2 text-sm">
        <Link href="/forgot-password" className="text-brand hover:underline">
          {t.auth.forgot}
        </Link>
        <p className="text-muted">
          {t.auth.noAccount}{' '}
          <Link href="/register" className="font-semibold text-brand hover:underline">
            {t.auth.createAccount}
          </Link>
        </p>
      </div>
    </>
  );
}
