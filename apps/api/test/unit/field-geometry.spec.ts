import { normalizeRotation, placeField, viewSize, viewToPdf, type Box } from '../../src/modules/evidence/field-geometry';

const box: Box = { x: 10, y: 20, width: 600, height: 800 }; // CropBox com deslocamento

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe('geometria de campos posicionados', () => {
  it('normaliza rotações', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
  });

  it('rotação 0: topo-esquerda da tela = topo-esquerda do PDF', () => {
    close(viewToPdf(box, 0, 0, 0), { x: 10, y: 820 });
    close(viewToPdf(box, 0, 1, 1), { x: 610, y: 20 });
    expect(viewSize(box, 0)).toEqual({ width: 600, height: 800 });
  });

  it('rotação 90: largura e altura exibidas se invertem', () => {
    expect(viewSize(box, 90)).toEqual({ width: 800, height: 600 });
    // topo-esquerda da tela = canto inferior esquerdo da página não rotacionada
    close(viewToPdf(box, 90, 0, 0), { x: 10, y: 20 });
    // topo-direita da tela = canto superior esquerdo não rotacionado
    close(viewToPdf(box, 90, 1, 0), { x: 10, y: 820 });
  });

  it.each([0, 90, 180, 270])('rotação %i: cantos do conteúdo coincidem com os cantos do campo', (rot) => {
    const field = { x: 0.2, y: 0.6, width: 0.3, height: 0.1 };
    const p = placeField(box, rot, field);
    const v = viewSize(box, rot);
    expect(p.contentWidth).toBeCloseTo(0.3 * v.width, 6);
    expect(p.contentHeight).toBeCloseTo(0.1 * v.height, 6);
    // local (0,0) = canto inferior esquerdo do campo na tela
    close(p.toPage(0, 0), viewToPdf(box, rot, field.x, field.y + field.height));
    // local (w,h) = canto superior direito do campo na tela
    close(p.toPage(p.contentWidth, p.contentHeight), viewToPdf(box, rot, field.x + field.width, field.y));
    // local (0,h) = canto superior esquerdo
    close(p.toPage(0, p.contentHeight), viewToPdf(box, rot, field.x, field.y));
  });
});
