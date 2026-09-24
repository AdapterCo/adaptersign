import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts, type RGB } from 'pdf-lib';
import { toWinAnsiSafe } from '../../common/util/text';

export const A4: [number, number] = [595.28, 841.89];

export const Colors = {
  text: rgb(0.106, 0.137, 0.2),
  muted: rgb(0.357, 0.392, 0.459),
  line: rgb(0.855, 0.875, 0.914),
  ok: rgb(0.0, 0.45, 0.25),
  bad: rgb(0.7, 0.1, 0.1),
};

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return rgb(0.12, 0.31, 0.82);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/** Quebra texto em linhas pela largura real da fonte (inclusive palavras longas como hashes). */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const safe = toWinAnsiSafe(text);
  const lines: string[] = [];
  for (const paragraph of safe.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth) {
        let cut = rest.length;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** Utilitário de layout sequencial (A4, paginação automática) sobre o pdf-lib. */
export class PdfWriter {
  page!: PDFPage;
  y = 0;
  readonly margin = 50;

  private constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly italic: PDFFont,
  ) {}

  static async create(existing?: PDFDocument): Promise<PdfWriter> {
    const doc = existing ?? (await PDFDocument.create());
    const [font, bold, italic] = await Promise.all([
      doc.embedFont(StandardFonts.Helvetica),
      doc.embedFont(StandardFonts.HelveticaBold),
      doc.embedFont(StandardFonts.HelveticaOblique),
    ]);
    const w = new PdfWriter(doc, font, bold, italic);
    w.newPage();
    return w;
  }

  get contentWidth(): number {
    return A4[0] - this.margin * 2;
  }

  newPage(): void {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - this.margin;
  }

  ensure(height: number): void {
    if (this.y - height < this.margin + 30) this.newPage();
  }

  text(value: string, opts: { size?: number; font?: PDFFont; color?: RGB; indent?: number; gap?: number } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.font ?? this.font;
    const indent = opts.indent ?? 0;
    const lineHeight = size * 1.35;
    for (const line of wrapText(value, font, size, this.contentWidth - indent)) {
      this.ensure(lineHeight);
      this.page.drawText(line, { x: this.margin + indent, y: this.y - size, size, font, color: opts.color ?? Colors.text });
      this.y -= lineHeight;
    }
    this.y -= opts.gap ?? 2;
  }

  heading(value: string, color?: RGB): void {
    this.ensure(40);
    this.y -= 10;
    this.text(value.toUpperCase(), { size: 11, font: this.bold, color: color ?? Colors.text, gap: 4 });
    this.rule();
  }

  keyValue(label: string, value: string, indent = 0): void {
    this.text(label, { size: 8, font: this.bold, color: Colors.muted, indent, gap: 0 });
    this.text(value, { size: 10, indent, gap: 5 });
  }

  rule(): void {
    this.ensure(8);
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: A4[0] - this.margin, y: this.y },
      thickness: 0.6,
      color: Colors.line,
    });
    this.y -= 8;
  }

  space(h: number): void {
    this.y -= h;
  }

  /** Rodapé em todas as páginas criadas por este writer (a partir de `fromPage`). */
  footer(render: (index: number, total: number) => string, fromPage = 0): void {
    const pages = this.doc.getPages().slice(fromPage);
    pages.forEach((p, i) => {
      const txt = toWinAnsiSafe(render(i + 1, pages.length));
      p.drawText(txt, { x: this.margin, y: 24, size: 7, font: this.font, color: Colors.muted });
    });
  }
}
