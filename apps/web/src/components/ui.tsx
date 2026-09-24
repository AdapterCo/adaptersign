'use client';

import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-dark disabled:bg-brand/50',
  secondary: 'bg-white text-ink border border-line hover:bg-canvas disabled:text-muted',
  danger: 'bg-bad text-white hover:bg-bad/90 disabled:bg-bad/50',
  ghost: 'text-brand hover:bg-brand-soft',
};

export function Button({ variant = 'primary', loading, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      {label ? <span>{label}</span> : <span className="sr-only">{t.common.loading}</span>}
    </span>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children(id, describedBy)}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass = 'min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-base text-ink placeholder:text-muted/70 focus:border-brand';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...props }, ref) {
  return <input ref={ref} {...props} className={`${inputClass} ${className}`} />;
});

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${className}`} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} min-h-24 ${className}`} />;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-white p-5 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const tones = {
    info: 'border-brand/30 bg-brand-soft text-ink',
    ok: 'border-ok/30 bg-ok/10 text-ok',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    bad: 'border-bad/30 bg-bad/10 text-bad',
  };
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  return (
    <Alert tone="bad">
      <p>{e?.message ?? t.common.errorGeneric}</p>
      {e?.requestId && <p className="mt-1 text-xs opacity-80">{t.common.requestId(e.requestId)}</p>}
    </Alert>
  );
}

const statusTone: Record<string, string> = {
  DRAFT: 'bg-canvas text-muted',
  ACTIVE: 'bg-brand-soft text-brand',
  PARTIALLY_SIGNED: 'bg-brand-soft text-brand',
  COMPLETED: 'bg-ok/10 text-ok',
  EXPIRED: 'bg-warn/10 text-warn',
  CANCELLED: 'bg-canvas text-muted',
  DECLINED: 'bg-bad/10 text-bad',
  PENDING: 'bg-canvas text-muted',
  INVITED: 'bg-brand-soft text-brand',
  VIEWED: 'bg-brand-soft text-brand',
  AUTHENTICATED: 'bg-brand-soft text-brand',
  SIGNED: 'bg-ok/10 text-ok',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusTone[status] ?? 'bg-canvas text-muted'}`}>
      {t.status[status] ?? status}
    </span>
  );
}

export function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Paginação" className="mt-4 flex items-center justify-between gap-2 text-sm">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {t.common.previous}
      </Button>
      <span className="text-muted">{t.common.page(page, totalPages)}</span>
      <Button variant="secondary" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        {t.common.nextPage}
      </Button>
    </nav>
  );
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold text-ink">{title}</h1>
      {actions}
    </div>
  );
}
