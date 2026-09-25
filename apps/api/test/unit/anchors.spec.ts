import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { FieldType, PageCorner } from '../../src/generated/prisma/client';
import { fieldFromAnchor, planTemplateFields, scanPage, type PageTextInput } from '../../src/modules/templates/anchors';
import { extractPagesText } from '../../src/modules/templates/pdf-text';
import { viewToPdf } from '../../src/modules/evidence/field-geometry';

const W = 600;
const H = 800;

/** Página sem rotação: y do PDF cresce para cima, y da visualização cresce para baixo. */
function page(items: PageTextInput['items'], n = 1): PageTextInput {
  return { page: n, viewWidth: W, viewHeight: H, toView: (x, y) => [x, H - y], items };
}

describe('scanPage', () => {
  it('encontra âncoras quebradas em pedaços e com espaços', () => {
    const scan = scanPage(
      page([
        { str: 'Assinatura: [[AS:assi', transform: [10, 0, 0, 10, 100, 200], width: 105 },
        { str: 'natura : Cliente]]', transform: [10, 0, 0, 10, 205, 200], width: 90 },
      ]),
    );
    expect(scan.invalid).toEqual([]);
    expect(scan.anchors).toHaveLength(1);
    const a = scan.anchors[0];
    expect(a).toMatchObject({ type: FieldType.SIGNATURE, role: 'cliente', page: 1 });
    // "Assinatura: " = 12 caracteres de 21 no primeiro item (5 pt cada).
    expect(a.x * W).toBeCloseTo(160, 5);
    expect(a.baseline * H).toBeCloseTo(600, 5);
    expect((a.y + a.height) * H).toBeCloseTo(600, 5);
    expect(a.y * H).toBeCloseTo(590, 5);
  });

  it('reporta âncoras com tipo desconhecido', () => {
    const scan = scanPage(page([{ str: '[[AS:carimbo:loja]] [[AS:data:loja]]', transform: [8, 0, 0, 8, 50, 50], width: 200 }]));
    expect(scan.invalid).toEqual([{ text: '[[AS:carimbo:loja]]', page: 1 }]);
    expect(scan.anchors.map((a) => a.type)).toEqual([FieldType.DATE]);
  });
});

describe('fieldFromAnchor', () => {
  const anchor = { text: '', role: 'loja', page: 1, x: 0.2, y: 0.49, width: 0.2, height: 0.01, baseline: 0.5 };

  it('apoia a assinatura na linha de base do marcador', () => {
    const f = fieldFromAnchor({ ...anchor, type: FieldType.SIGNATURE }, W, H);
    expect(f.x).toBeCloseTo(0.2);
    // 20% da altura desce abaixo da linha de base, encostando na linha de assinatura.
    expect(f.y + f.height * 0.8).toBeCloseTo(0.5);
    expect(f.width * W).toBeCloseTo(150);
  });

  it('centraliza nome/data no marcador e nunca sai da página', () => {
    const f = fieldFromAnchor({ ...anchor, type: FieldType.DATE }, W, H);
    expect(f.y + f.height / 2).toBeCloseTo(0.495);
    const edge = fieldFromAnchor({ ...anchor, type: FieldType.NAME, x: 0.95 }, W, H);
    expect(edge.x + edge.width).toBeLessThanOrEqual(1);
  });
});

describe('planTemplateFields', () => {
  const roles = [
    { key: 'loja', initialsAllPages: true, initialsCorner: PageCorner.BOTTOM_RIGHT },
    { key: 'cliente', initialsAllPages: true, initialsCorner: PageCorner.BOTTOM_RIGHT },
  ];

  it('gera campos, rubricas em todas as páginas e aponta pendências', () => {
    const p1 = scanPage(page([{ str: '[[AS:rubrica:cliente]] [[AS:assinatura:vendedor]]', transform: [8, 0, 0, 8, 50, 50], width: 300 }], 1));
    const p2 = scanPage(page([{ str: '[[AS:assinatura:cliente]]', transform: [8, 0, 0, 8, 50, 100], width: 150 }], 2));
    const plan = planTemplateFields(roles, [
      { ref: 'doc', pages: [{ page: 1, viewWidth: W, viewHeight: H, scan: p1 }, { page: 2, viewWidth: W, viewHeight: H, scan: p2 }] },
    ]);
    expect(plan.missingSignature).toEqual(['loja']);
    expect(plan.unknownRoles).toEqual(['vendedor']);
    const initials = plan.fields.filter((f) => f.type === FieldType.INITIALS);
    // Página 1: rubrica do cliente veio da âncora; a da loja, do canto. Página 2: as duas do canto.
    expect(initials.map((f) => `${f.page}:${f.role}:${f.source}`).sort()).toEqual([
      '1:cliente:anchor',
      '1:loja:all_pages',
      '2:cliente:all_pages',
      '2:loja:all_pages',
    ]);
    const [a, b] = initials.filter((f) => f.page === 2);
    expect(a.x).not.toBeCloseTo(b.x); // empilhadas lado a lado no mesmo canto
    expect(a.y + a.height).toBeLessThan(1);
  });
});

describe('extractPagesText (pdf.js)', () => {
  it('localiza âncoras em páginas rotacionadas de forma coerente com field-geometry', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595.28, 841.89]);
    p1.drawText('Loja: [[AS:assinatura:loja]]', { x: 72, y: 120, size: 6, font, color: rgb(1, 1, 1) });
    const p2 = doc.addPage([595.28, 841.89]);
    p2.setRotation(degrees(90));
    p2.drawText('[[AS:assinatura:cliente]]', { x: 300, y: 400, size: 8, font });
    const pdf = Buffer.from(await doc.save());

    const pages = await extractPagesText(pdf, { maxPages: 10 });
    expect(pages).toHaveLength(2);
    expect(pages[1].viewWidth).toBeCloseTo(841.89);

    const a1 = scanPage(pages[0]).anchors[0];
    expect(a1).toMatchObject({ role: 'loja', type: FieldType.SIGNATURE });
    const start = viewToPdf({ x: 0, y: 0, width: 595.28, height: 841.89 }, 0, a1.x, a1.baseline);
    // Largura por caractere é proporcional (aprox.): tolera 2 pt (< 1 mm).
    expect(Math.abs(start.x - (72 + font.widthOfTextAtSize('Loja: ', 6)))).toBeLessThan(2);
    expect(start.y).toBeCloseTo(120, 0);

    const a2 = scanPage(pages[1]).anchors[0];
    expect(a2).toMatchObject({ role: 'cliente', page: 2 });
    // Em 90°, o início do texto (x=300,y=400 no PDF) corresponde a um canto do retângulo visível.
    const corners = [
      [a2.x, a2.y],
      [a2.x + a2.width, a2.y],
      [a2.x, a2.y + a2.height],
      [a2.x + a2.width, a2.y + a2.height],
    ].map(([u, v]) => viewToPdf({ x: 0, y: 0, width: 595.28, height: 841.89 }, 90, u, v));
    expect(corners.some((c) => Math.abs(c.x - 300) < 1 && Math.abs(c.y - 400) < 1)).toBe(true);
  });

  it('recusa PDFs acima do limite de páginas', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    await expect(extractPagesText(Buffer.from(await doc.save()), { maxPages: 1 })).rejects.toThrow('limite');
  });
});
