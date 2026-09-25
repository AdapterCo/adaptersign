'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { t } from '@/lib/i18n';
import { useApi } from '@/lib/use-api';
import type { Template } from '@/lib/types';
import { TemplateEditor, TemplateTester } from '@/components/templates';
import { ErrorMessage, PageHeader, Spinner } from '@/components/ui';

export default function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: tpl, error, loading, setData } = useApi<Template>(`/templates/${id}`);

  if (loading && !tpl) return <Spinner label={t.common.loading} />;
  if (!tpl) return <ErrorMessage error={error} />;

  return (
    <>
      <PageHeader
        title={tpl.name}
        actions={
          <Link href="/templates" className="text-sm text-brand hover:underline">
            {t.templates.title}
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        <TemplateEditor initial={tpl} onSaved={setData} />
        <TemplateTester template={tpl} />
      </div>
    </>
  );
}
