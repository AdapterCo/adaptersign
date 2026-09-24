'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { ErrorMessage, Spinner } from './ui';

const MAX_PAGES_RENDERED = 100;

/**
 * Visualizador seguro: o PDF é obtido por endpoint autenticado (sem URL pública permanente)
 * e renderizado em canvas pelo pdf.js — funciona em celulares (inclusive iOS).
 */
export function PdfViewer({ path, title }: { path: string; title: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [pages, setPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const host = container.current;
    if (!host) return;
    host.innerHTML = '';
    setState('loading');

    (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      const res = await apiFetch(path);
      const data = new Uint8Array(await res.arrayBuffer());
      const doc = await pdfjs.getDocument({ data }).promise;
      if (cancelled) return;
      setPages(doc.numPages);
      const width = Math.min(host.clientWidth || 800, 1000);
      const ratio = window.devicePixelRatio || 1;
      for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES_RENDERED); i++) {
        const page = await doc.getPage(i);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = '100%';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${title} — página ${i} de ${doc.numPages}`);
        canvas.className = 'mb-3 rounded border border-line bg-white shadow-sm';
        host.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
      }
      if (!cancelled) setState('ready');
    })().catch((err) => {
      if (!cancelled) {
        setError(err);
        setState('error');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [path, title]);

  return (
    <div>
      {state === 'loading' && <Spinner label={t.common.loading} />}
      {state === 'error' && <ErrorMessage error={error} />}
      <div ref={container} aria-busy={state === 'loading'} />
      {pages > MAX_PAGES_RENDERED && <p className="text-sm text-muted">+{pages - MAX_PAGES_RENDERED} páginas — baixe o PDF para ver o documento completo.</p>}
    </div>
  );
}
