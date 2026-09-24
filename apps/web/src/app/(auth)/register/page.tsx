'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button, ErrorMessage, Field, Input } from '@/components/ui';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/auth/register', { method: 'POST', body: form, noRefresh: true });
      router.replace('/dashboard');
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold">{t.auth.registerTitle}</h1>
      <p className="mt-1 mb-6 text-sm text-muted">{t.auth.registerSubtitle}</p>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t.auth.organizationName}>
          {(id) => <Input id={id} required minLength={2} autoComplete="organization" value={form.organizationName} onChange={set('organizationName')} />}
        </Field>
        <Field label={t.auth.name}>{(id) => <Input id={id} required minLength={2} autoComplete="name" value={form.name} onChange={set('name')} />}</Field>
        <Field label={t.auth.email}>{(id) => <Input id={id} type="email" required autoComplete="email" value={form.email} onChange={set('email')} />}</Field>
        <Field label={t.auth.password} hint={t.auth.passwordHint}>
          {(id, d) => <Input id={id} aria-describedby={d} type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={set('password')} />}
        </Field>
        <ErrorMessage error={error} />
        <Button type="submit" loading={loading}>
          {t.auth.register}
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        {t.auth.haveAccount}{' '}
        <Link href="/login" className="font-semibold text-brand hover:underline">
          {t.auth.login}
        </Link>
      </p>
    </>
  );
}
