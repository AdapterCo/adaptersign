'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { ErrorMessage, Spinner } from './ui';

const MAX_PAGES_RENDERED = 100;

export interface PdfViewerProps {
  path: string;
  title: string;
  /**
   * Conteúdo sobreposto à página (campos). Posicione com porcentagens: o contêiner tem o
   * tamanho exato da página exibida, então left/top/width/height em % = coordenadas 0..1.
   */
  overlay?: (page: number) => ReactNode;
  /** Clique na página, com a posição em frações (0..1) a partir do canto superior esquerdo. */
  onPageClick?: (page: number, fx: number, fy: number) => void;
}

function PdfPage({ doc, number, width, title, overlay, onPageClick }: { doc: PDFDocumentProxy; number: number; width: number; title: string } & Pick<PdfViewerProps, 'overlay' | 'onPageClick'>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(number);
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      const c = canvas.current;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport, canvas: c } as Parameters<typeof page.render>[0]).promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, number, width]);

  function click(e: MouseEvent<HTMLDivElement>) {
    if (!onPageClick || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onPageClick(number, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  }

  return (
    <div className="relative mb-3 overflow-hidden rounded border border-line bg-white shadow-sm" style={{ aspectRatio: ratio ? `1 / ${ratio}` : '1 / 1.414' }}>
      <canvas ref={canvas} role="img" aria-label={`${title} — página ${number}`} className="absolute inset-0 h-full w-full" />
      <div data-page-layer className={`absolute inset-0 ${onPageClick ? 'cursor-crosshair' : ''}`} onClick={click}>
        {overlay?.(number)}
      </div>
    </div>
  );
}

/**
 * Visualizador seguro: o PDF é obtido por endpoint autenticado (sem URL pública permanente)
 * e renderizado em canvas pelo pdf.js — funciona em celulares (inclusive iOS).
 */
export function PdfViewer({ path, title, overlay, onPageClick }: PdfViewerProps) {
  const container = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      const res = await apiFetch(path);
      const data = new Uint8Array(await res.arrayBuffer());
      const loaded = await pdfjs.getDocument({ data }).promise;
      if (!cancelled) setDoc(loaded);
    })().catch((err) => {
      if (!cancelled) setError(err);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const update = () => setWidth(Math.min(el.clientWidth || 800, 1000));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pages = doc ? Math.min(doc.numPages, MAX_PAGES_RENDERED) : 0;
  return (
    <div ref={container}>
      {!doc && !error && <Spinner label={t.common.loading} />}
      {Boolean(error) && <ErrorMessage error={error} />}
      {doc &&
        width > 0 &&
        Array.from({ length: pages }, (_, i) => (
          <PdfPage key={i} doc={doc} number={i + 1} width={width} title={title} overlay={overlay} onPageClick={onPageClick} />
        ))}
      {doc && doc.numPages > MAX_PAGES_RENDERED && (
        <p className="text-sm text-muted">+{doc.numPages - MAX_PAGES_RENDERED} páginas — baixe o PDF para ver o documento completo.</p>
      )}
    </div>
  );
}
