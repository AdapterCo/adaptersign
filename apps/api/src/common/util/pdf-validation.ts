import { PDFDocument } from 'pdf-lib';
import { Errors } from '../errors/app-error';

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

/** Verifica a assinatura (magic bytes) — nunca confiar apenas no Content-Type. */
export function hasPdfMagic(buf: Buffer): boolean {
  // A especificação permite lixo antes do cabeçalho; aceitamos até 1024 bytes.
  const head = buf.subarray(0, Math.min(buf.length, 1024));
  return head.indexOf(PDF_MAGIC) !== -1;
}

export function hasPdfExtension(filename: string): boolean {
  return /\.pdf$/i.test(filename.trim());
}

export interface PdfInspection {
  pageCount: number;
}

/**
 * Valida que o PDF é processável: estrutura legível pelo pdf-lib, não cifrado
 * e com ao menos uma página. Lança erro de validação caso contrário.
 */
export async function inspectPdf(buf: Buffer): Promise<PdfInspection> {
  if (!hasPdfMagic(buf)) {
    throw Errors.validation('O arquivo enviado não é um PDF válido.', { reason: 'magic_bytes' });
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf, { updateMetadata: false });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'EncryptedPDFError') {
      throw Errors.validation('PDFs protegidos por senha/criptografia não são suportados.', { reason: 'encrypted' });
    }
    throw Errors.validation('Não foi possível processar o PDF (estrutura inválida ou corrompida).', { reason: 'unparseable' });
  }
  let pageCount = 0;
  try {
    pageCount = doc.getPageCount();
  } catch {
    throw Errors.validation('Não foi possível processar o PDF (estrutura inválida ou corrompida).', { reason: 'unparseable' });
  }
  if (pageCount < 1) {
    throw Errors.validation('O PDF não possui páginas.', { reason: 'empty' });
  }
  return { pageCount };
}
