// Geometria dos campos posicionados — ÚNICO ponto de conversão entre as coordenadas da
// interface (normalizadas 0..1, origem no canto superior esquerdo da página VISÍVEL, já
// rotacionada, como o pdf.js exibe) e o espaço de usuário do PDF (pontos, origem no canto
// inferior esquerdo da página NÃO rotacionada).

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rotação de exibição da página (/Rotate), normalizada para 0, 90, 180 ou 270 (sentido horário). */
export function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Dimensões da página como exibida (largura/altura trocam em 90°/270°). */
export function viewSize(box: Box, rotation: number): { width: number; height: number } {
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270 ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}

/** Converte um ponto da visualização (u,v ∈ 0..1, origem superior esquerda) para o espaço do PDF. */
export function viewToPdf(box: Box, rotation: number, u: number, v: number): { x: number; y: number } {
  const { x: bx, y: by, width: bw, height: bh } = box;
  switch (normalizeRotation(rotation)) {
    case 0:
      return { x: bx + u * bw, y: by + bh - v * bh };
    case 90:
      return { x: bx + v * bw, y: by + u * bh };
    case 180:
      return { x: bx + (1 - u) * bw, y: by + v * bh };
    case 270:
      return { x: bx + bw - v * bw, y: by + bh - u * bh };
  }
}

export interface FieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Posicionamento de um campo para desenho com pdf-lib:
 * - `contentWidth`/`contentHeight`: tamanho do campo como o usuário o vê (pontos);
 * - `toPage(lx, ly)`: converte coordenadas LOCAIS do conteúdo (origem no canto inferior
 *   esquerdo do campo, eixo y para cima, como o usuário vê) para o espaço do PDF;
 * - `rotate`: ângulo (graus, anti-horário) a aplicar em drawImage/drawText para que o
 *   conteúdo apareça "de pé" na página exibida.
 */
export interface FieldPlacement {
  contentWidth: number;
  contentHeight: number;
  rotate: number;
  toPage: (lx: number, ly: number) => { x: number; y: number };
}

export function placeField(box: Box, rotation: number, field: FieldRect): FieldPlacement {
  const r = normalizeRotation(rotation);
  const view = viewSize(box, r);
  const contentWidth = field.width * view.width;
  const contentHeight = field.height * view.height;
  // Origem local = canto inferior esquerdo do campo na visualização.
  const anchor = viewToPdf(box, r, field.x, field.y + field.height);
  // A página exibida é girada r graus no sentido horário; o conteúdo é pré-girado r graus
  // no sentido anti-horário para aparecer na orientação correta.
  const rad = (r * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  return {
    contentWidth,
    contentHeight,
    rotate: r,
    toPage: (lx, ly) => ({ x: anchor.x + lx * cos - ly * sin, y: anchor.y + lx * sin + ly * cos }),
  };
}
