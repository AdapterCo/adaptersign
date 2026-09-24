import Link from 'next/link';
import type { ReactNode } from 'react';
import { branding } from '@/lib/branding';
import { t } from '@/lib/i18n';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-xl font-bold text-brand">
        {branding.name}
      </Link>
      <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">{children}</div>
      <Link href="/verify" className="mt-6 text-sm text-muted underline-offset-4 hover:underline">
        {t.nav.verify}
      </Link>
    </main>
  );
}
