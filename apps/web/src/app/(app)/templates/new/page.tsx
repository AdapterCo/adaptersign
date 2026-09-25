'use client';

import Link from 'next/link';
import { t } from '@/lib/i18n';
import { TemplateEditor } from '@/components/templates';
import { Alert, PageHeader } from '@/components/ui';

export default function NewTemplatePage() {
  return (
    <>
      <PageHeader
        title={t.templates.new}
        actions={
          <Link href="/templates" className="text-sm text-brand hover:underline">
            {t.templates.title}
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        <TemplateEditor />
        <Alert>{t.templates.saveFirst}</Alert>
      </div>
    </>
  );
}
