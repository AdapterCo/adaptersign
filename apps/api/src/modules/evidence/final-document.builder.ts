import { degrees, PDFDocument, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { toWinAnsiSafe } from '../../common/util/text';
import type { Branding } from '../../config/branding';
import { Colors, hexToRgb, PdfWriter } from './pdf-writer';
import { placeField, type FieldRect } from './field-geometry';

export interface PositionedField extends FieldRect {
  type: 'SIGNATURE' | 'INITIALS' | 'NAME' | 'DATE';
  page: number; // 1-based
}

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
    /** Campos posicionados deste signatário NESTE documento (opcional). */
    fields?: PositionedField[];
  }>;
}

/** Maior tamanho de fonte (≤ max) em que o texto cabe na caixa. */
function fitFontSize(font: PDFFont, text: string, maxWidth: number, maxHeight: number, max: number): number {
  let size = Math.min(max, maxHeight * 0.75);
  while (size > 4 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return Math.max(size, 4);
}

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 2 || /^[A-ZÀ-Ý]/.test(p))
    .map((p) => p[0]!.toUpperCase())
    .join('')
    .slice(0, 4);
}

interface DrawCtx {
  font: PDFFont;
  italic: PDFFont;
  tz: string;
}

/** Desenha um campo na página original usando a geometria (CropBox + rotação). */
function drawField(
  page: PDFPage,
  field: PositionedField,
  signer: FinalDocumentData['signers'][number],
  image: PDFImage | null,
  ctx: DrawCtx,
): void {
  const p = placeField(page.getCropBox(), page.getRotation().angle, field);
  const W = p.contentWidth;
  const H = p.contentHeight;
  const rotate = degrees(p.rotate);
  const pad = Math.min(2, W * 0.05, H * 0.05);

  const drawTextFitted = (raw: string, font: PDFFont, max: number) => {
    const text = toWinAnsiSafe(raw);
    const size = fitFontSize(font, text, W - pad * 2, H - pad * 2, max);
    const pos = p.toPage(pad, (H - size) / 2 + size * 0.22);
    page.drawText(text, { x: pos.x, y: pos.y, size, font, color: Colors.text, rotate });
  };

  const useImage = (field.type === 'SIGNATURE' || field.type === 'INITIALS') && image;
  if (useImage) {
    const scale = Math.min((W - pad * 2) / image.width, (H - pad * 2) / image.height);
    const iw = image.width * scale;
    const ih = image.height * scale;
    const pos = p.toPage((W - iw) / 2, (H - ih) / 2);
    page.drawImage(image, { x: pos.x, y: pos.y, width: iw, height: ih, rotate });
    return;
  }
  switch (field.type) {
    case 'SIGNATURE':
      drawTextFitted(signer.typedName ?? signer.name, ctx.italic, 22);
      return;
    case 'INITIALS':
      drawTextFitted(initialsOf(signer.typedName ?? signer.name), ctx.italic, 18);
      return;
    case 'NAME':
      drawTextFitted(signer.name, ctx.font, 11);
      return;
    case 'DATE':
      drawTextFitted(new Intl.DateTimeFormat('pt-BR', { timeZone: ctx.tz, dateStyle: 'short' }).format(signer.signedAt), ctx.font, 11);
      return;
  }
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

  // Campos posicionados: desenhados nas páginas ORIGINAIS, na posição definida no envelope.
  const images = new Map<number, PDFImage>();
  for (const [i, s] of data.signers.entries()) {
    if (!s.fields?.length) continue;
    let image: PDFImage | null = null;
    if (s.method === 'DRAWN' && s.image) {
      image = images.get(i) ?? (await doc.embedPng(s.image));
      images.set(i, image);
    }
    for (const f of s.fields) {
      if (f.page < 1 || f.page > originalPageCount) continue;
      drawField(doc.getPage(f.page - 1), f, s, image, { font: w.font, italic: w.italic, tz });
    }
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
