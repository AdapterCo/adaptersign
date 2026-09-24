import { PDFDocument } from 'pdf-lib';
import { toWinAnsiSafe } from '../../common/util/text';
import type { Branding } from '../../config/branding';
import { Colors, hexToRgb, PdfWriter } from './pdf-writer';

export interface FinalDocumentData {
  brand: Branding;
  timezone: string;
  validationCode: string;
  envelopeTitle: string;
  filename: string;
  originalSha256: string;
  signers: Array<{
    name: string;
    email: string; // mascarado
    role: string;
    authentication: string;
    signedAt: Date;
    method: 'TYPED' | 'DRAWN';
    typedName: string | null;
    image: Buffer | null;
  }>;
}

const ROLE_LABEL: Record<string, string> = { SIGNER: 'Signatário', APPROVER: 'Aprovador', WITNESS: 'Testemunha' };

/**
 * Gera o documento FINAL a partir do original (que permanece preservado intacto no storage):
 * páginas originais + rodapé discreto de referência + página(s) de assinaturas.
 */
export async function buildFinalDocument(original: Buffer, data: FinalDocumentData): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const originalPageCount = doc.getPageCount();
  const w = await PdfWriter.create(doc);
  const brandColor = hexToRgb(data.brand.primaryColor);
  const tz = data.timezone;

  const stamp = toWinAnsiSafe(
    `Documento assinado eletronicamente via ${data.brand.name} · Código ${data.validationCode} · Verifique em ${data.brand.appUrl}/verify`,
  );
  for (const page of doc.getPages().slice(0, originalPageCount)) {
    const { width } = page.getSize();
    const size = 6.5;
    const textWidth = w.font.widthOfTextAtSize(stamp, size);
    page.drawText(stamp, { x: Math.max(10, (width - textWidth) / 2), y: 8, size, font: w.font, color: Colors.muted });
  }

  w.text(data.brand.name, { size: 12, font: w.bold, color: brandColor, gap: 6 });
  w.text('Página de assinaturas', { size: 16, font: w.bold, gap: 4 });
  w.text(data.envelopeTitle, { size: 11, gap: 2 });
  w.text(`Documento: ${data.filename}`, { size: 9, color: Colors.muted, gap: 2 });
  w.text(`SHA-256 do original: ${data.originalSha256}`, { size: 8, color: Colors.muted, gap: 2 });
  w.text(`Código de validação: ${data.validationCode} · ${data.brand.appUrl}/verify`, { size: 9, font: w.bold, gap: 10 });
  w.rule();

  const fmt = (d: Date) =>
    `${new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(d)} (${tz}) · ${d.toISOString()}`;

  for (const s of data.signers) {
    w.ensure(120);
    const top = w.y;
    const boxH = 60;
    const boxW = 200;
    w.page.drawRectangle({ x: w.margin, y: top - boxH, width: boxW, height: boxH, borderColor: Colors.line, borderWidth: 0.8 });
    if (s.method === 'DRAWN' && s.image) {
      const img = await doc.embedPng(s.image);
      const scale = Math.min((boxW - 10) / img.width, (boxH - 10) / img.height, 1);
      const iw = img.width * scale;
      const ih = img.height * scale;
      w.page.drawImage(img, { x: w.margin + (boxW - iw) / 2, y: top - boxH + (boxH - ih) / 2, width: iw, height: ih });
    } else {
      const name = toWinAnsiSafe(s.typedName ?? s.name);
      let size = 20;
      while (size > 9 && w.italic.widthOfTextAtSize(name, size) > boxW - 12) size--;
      w.page.drawText(name, { x: w.margin + 6, y: top - boxH / 2 - size / 3, size, font: w.italic, color: Colors.text });
    }
    const infoX = boxW + 14;
    const saveY = w.y;
    w.y = top;
    w.text(s.name, { size: 10.5, font: w.bold, indent: infoX, gap: 0 });
    w.text(`${ROLE_LABEL[s.role] ?? s.role} · ${s.email}`, { size: 8.5, color: Colors.muted, indent: infoX, gap: 0 });
    w.text(`Autenticação: ${s.authentication}`, { size: 8.5, indent: infoX, gap: 0 });
    w.text(`Assinado em: ${fmt(s.signedAt)}`, { size: 8.5, indent: infoX, gap: 0 });
    w.y = Math.min(w.y, saveY - boxH) - 16;
  }

  w.rule();
  w.text(
    'A imagem ou nome acima é apenas a representação visual da assinatura. As evidências técnicas (autenticação, aceite, ' +
      'horários do servidor, hashes e trilha de auditoria encadeada) constam no relatório de evidências vinculado ao código de validação.',
    { size: 8, color: Colors.muted },
  );

  return doc.save({ useObjectStreams: false });
}
