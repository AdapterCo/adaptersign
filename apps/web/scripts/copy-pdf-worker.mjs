// Copia o worker do pdf.js para /public (servido pela própria origem; CSP worker-src 'self').
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(require.resolve('pdfjs-dist/package.json'));
const src = join(pkgDir, 'build', 'pdf.worker.min.mjs');
const destDir = join(here, '..', 'public');
mkdirSync(destDir, { recursive: true });
copyFileSync(src, join(destDir, 'pdf.worker.min.mjs'));
console.log('pdf.worker.min.mjs copiado para public/');
