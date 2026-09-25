// Extração de texto posicionado de PDFs (pdf.js) para a busca de âncoras.
//
// pdfjs-dist é distribuído apenas como ESM; o carregamos com require(esm) (Node ≥ 22.12).
// Nos testes, o Jest precisa de --experimental-vm-modules (ver scripts do package.json).
// O worker é pré-carregado em globalThis.pdfjsWorker para que o pdf.js rode na mesma
// thread sem import() dinâmico.
//
// O PDF é conteúdo NÃO confiável: avaliação de código de fontes desligada, sem fontes do
// sistema e com limite de páginas. As coordenadas usam o mesmo viewport do visualizador web
// (CropBox + /Rotate), garantindo que "o que o usuário vê" = "o que é gravado".

import { dirname, join } from 'node:path';
import type { PageTextInput } from './anchors';

interface PdfViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport;
  getTextContent(): Promise<{ items: Array<{ str?: unknown; transform?: unknown; width?: unknown }> }>;
  cleanup(): void;
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

interface PdfJs {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}

let pdfjs: PdfJs | undefined;
let assetsDir: string | undefined;

function load(): { lib: PdfJs; assets: string } {
  if (!pdfjs) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = require('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs') as PdfJs;
    /* eslint-enable @typescript-eslint/no-require-imports */
    assetsDir = dirname(require.resolve('pdfjs-dist/package.json'));
  }
  return { lib: pdfjs, assets: assetsDir as string };
}

export class PdfTextError extends Error {
  override name = 'PdfTextError';
}

/** Texto de cada página, pronto para anchors.scanPage. */
export async function extractPagesText(pdf: Buffer, opts: { maxPages: number }): Promise<PageTextInput[]> {
  const { lib, assets } = load();
  const task = lib.getDocument({
    data: new Uint8Array(pdf), // cópia: o pdf.js assume a posse do buffer
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    standardFontDataUrl: join(assets, 'standard_fonts') + '/',
    cMapUrl: join(assets, 'cmaps') + '/',
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    let doc: PdfDocument;
    try {
      doc = await task.promise;
    } catch {
      throw new PdfTextError('Não foi possível ler o texto do PDF.');
    }
    if (doc.numPages > opts.maxPages) throw new PdfTextError(`O PDF excede o limite de ${opts.maxPages} páginas.`);
    const pages: PageTextInput[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.flatMap((it) =>
        typeof it.str === 'string' && Array.isArray(it.transform) && it.transform.length === 6 && typeof it.width === 'number'
          ? [{ str: it.str, transform: it.transform as number[], width: it.width }]
          : [],
      );
      pages.push({
        page: n,
        viewWidth: viewport.width,
        viewHeight: viewport.height,
        toView: (x, y) => {
          const [vx, vy] = viewport.convertToViewportPoint(x, y);
          return [vx, vy];
        },
        items,
      });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
