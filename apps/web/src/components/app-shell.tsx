'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { branding } from '@/lib/branding';
import { t } from '@/lib/i18n';
import { useSession } from './session';
import { Alert, Button, Spinner } from './ui';

export function AppShell({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [resent, setResent] = useState(false);

  const items = [
    { href: '/dashboard', label: t.nav.dashboard },
    { href: '/envelopes', label: t.nav.envelopes },
    { href: '/documents', label: t.nav.documents },
    ...(me?.permissions.includes('template:read') ? [{ href: '/templates', label: t.nav.templates }] : []),
    { href: '/settings', label: t.nav.settings },
    ...(me?.user.isPlatformAdmin ? [{ href: '/admin', label: t.nav.admin }] : []),
  ];

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label={t.common.loading} />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded focus:bg-white focus:p-2">
        {t.nav.skip}
      </a>
      <header className="sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/dashboard" className="text-lg font-bold text-brand">
            {branding.name}
          </Link>
          <button className="rounded-lg p-2 md:hidden" aria-expanded={open} aria-controls="nav-principal" onClick={() => setOpen(!open)}>
            {t.nav.menu}
          </button>
          <nav id="nav-principal" aria-label="Principal" className={`${open ? 'flex' : 'hidden'} absolute top-full right-0 left-0 flex-col border-b border-line bg-white p-4 md:static md:flex md:flex-row md:items-center md:gap-1 md:border-0 md:p-0`}>
            {items.map((i) => {
              const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
              return (
                <Link
                  key={i.href}
                  href={i.href}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium ${active ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-canvas'}`}
                >
                  {i.label}
                </Link>
              );
            })}
            <span className="px-3 py-2 text-xs text-muted md:ml-3">{me.organization?.name}</span>
            <Button variant="ghost" onClick={logout}>
              {t.nav.logout}
            </Button>
          </nav>
        </div>
      </header>
      <main id="conteudo" className="mx-auto max-w-6xl px-4 py-8">
        {!me.user.emailVerified && (
          <div className="mb-6">
            <Alert tone="warn">
              <span>{resent ? t.auth.verificationSent : t.auth.emailNotVerified} </span>
              {!resent && (
                <button
                  className="font-semibold underline"
                  onClick={() => api('/auth/verify-email/request', { method: 'POST' }).then(() => setResent(true)).catch(() => undefined)}
                >
                  {t.auth.resendVerification}
                </button>
              )}
            </Alert>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
