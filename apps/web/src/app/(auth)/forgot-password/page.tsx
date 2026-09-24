'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Alert, Button, ErrorMessage, Field, Input } from '@/components/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email }, noRefresh: true });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold">{t.auth.forgotTitle}</h1>
      <p className="mt-1 mb-6 text-sm text-muted">{t.auth.forgotSubtitle}</p>
      {sent ? (
        <Alert tone="ok">{t.auth.forgotSent}</Alert>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t.auth.email}>{(id) => <Input id={id} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <ErrorMessage error={error} />
          <Button type="submit" loading={loading}>
            {t.auth.sendLink}
          </Button>
        </form>
      )}
      <Link href="/login" className="mt-6 inline-block text-sm text-brand hover:underline">
        {t.common.back}
      </Link>
    </>
  );
}
