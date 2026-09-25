'use client';

import Link from 'next/link';
import { t } from '@/lib/i18n';
import { useApi } from '@/lib/use-api';
import type { Template } from '@/lib/types';
import { useSession } from '@/components/session';
import { Card, ErrorMessage, PageHeader, Spinner } from '@/components/ui';

export default function TemplatesPage() {
  const { can } = useSession();
  const { data, error, loading } = useApi<Template[]>('/templates');

  return (
    <>
      <PageHeader
        title={t.templates.title}
        actions={
          can('template:write') && (
            <Link href="/templates/new" className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white">
              {t.templates.new}
            </Link>
          )
        }
      />
      {loading && !data && <Spinner label={t.common.loading} />}
      <ErrorMessage error={error} />
      {data && data.length === 0 && (
        <Card>
          <p className="text-sm text-muted">{t.templates.empty}</p>
        </Card>
      )}
      {data && data.length > 0 && (
        <Card>
          <ul className="divide-y divide-line">
            {data.map((tpl) => (
              <li key={tpl.id}>
                <Link href={`/templates/${tpl.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3 hover:text-brand">
                  <div className="min-w-0">
                    <p className="font-medium">{tpl.name}</p>
                    <p className="font-mono text-xs text-muted">{tpl.key}</p>
                  </div>
                  <p className="text-sm text-muted">
                    {tpl.roles.map((r) => r.label).join(' → ')} · {t.templates.roleCount(tpl.roles.length)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
