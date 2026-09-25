// Âncoras de posicionamento — marcadores de texto embutidos no PDF pelo sistema de origem:
//
//   [[AS:<tipo>:<papel>]]     ex.: [[AS:assinatura:cliente]], [[AS:rubrica:loja]], [[AS:data:cliente]]
//
// tipo ∈ assinatura | rubrica | nome | data; papel = chave do papel no modelo.
// A busca ignora espaços e maiúsculas/minúsculas (geradores de PDF costumam quebrar o texto em
// pedaços). Este módulo é PURO: recebe o texto já extraído (pdf-text.ts) e devolve coordenadas
// normalizadas (0..1, origem superior esquerda da página VISÍVEL) — o mesmo sistema de
// EnvelopeField, que é convertido para o espaço do PDF apenas por evidence/field-geometry.ts.

import { FieldType, PageCorner } from '../../generated/prisma/client';

export const ANCHOR_TYPES: Readonly<Record<string, FieldType>> = {
  assinatura: FieldType.SIGNATURE,
  rubrica: FieldType.INITIALS,
  nome: FieldType.NAME,
  data: FieldType.DATE,
};

/** Tamanho padrão dos campos criados por âncora (pontos, na página visível). */
export const FIELD_SIZE_PT: Readonly<Record<FieldType, { width: number; height: number }>> = {
  SIGNATURE: { width: 150, height: 42 },
  INITIALS: { width: 56, height: 28 },
  NAME: { width: 170, height: 16 },
  DATE: { width: 90, height: 16 },
};

/** Fração da altura da assinatura/rubrica abaixo da linha de base do marcador. */
const SIGNATURE_OVERLAP = 0.2;
const CORNER_MARGIN_PT = 18;
const CORNER_GAP_PT = 6;

export interface TextItemInput {
  str: string;
  /** Matriz [a, b, c, d, e, f] do pdf.js (espaço de usuário do PDF; origem na linha de base). */
  transform: number[];
  /** Largura do texto no espaço do PDF, ao longo da direção do texto. */
  width: number;
}

export interface PageTextInput {
  page: number;
  /** Dimensões da página visível (pontos). */
  viewWidth: number;
  viewHeight: number;
  /** Espaço do PDF → página visível (pontos, origem superior esquerda). */
  toView: (x: number, y: number) => [number, number];
  items: TextItemInput[];
}

export interface FoundAnchor {
  text: string;
  type: FieldType;
  role: string;
  page: number;
  /** Retângulo do marcador, normalizado. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Linha de base do marcador (y normalizado). */
  baseline: number;
}

export interface InvalidAnchor {
  text: string;
  page: number;
}

export interface AnchorScan {
  anchors: FoundAnchor[];
  invalid: InvalidAnchor[];
}

interface CharRef {
  item: number;
  index: number;
}

const ANCHOR_RE = /\[\[AS:([^\]]{0,80})\]\]/gi;
const INNER_RE = /^([a-z]+):([a-z0-9][a-z0-9_-]{0,39})$/;

/** Localiza as âncoras de uma página. */
export function scanPage(input: PageTextInput): AnchorScan {
  // Texto compacto (sem espaços) + referência de cada caractere ao item/posição de origem.
  let compact = '';
  const refs: CharRef[] = [];
  input.items.forEach((it, item) => {
    for (let index = 0; index < it.str.length; index++) {
      const ch = it.str[index];
      if (/\s/.test(ch)) continue;
      compact += ch;
      refs.push({ item, index });
    }
  });

  const anchors: FoundAnchor[] = [];
  const invalid: InvalidAnchor[] = [];
  for (const m of compact.matchAll(ANCHOR_RE)) {
    const text = m[0];
    const inner = INNER_RE.exec(m[1].toLowerCase());
    const type = inner ? ANCHOR_TYPES[inner[1]] : undefined;
    if (!inner || !type) {
      invalid.push({ text, page: input.page });
      continue;
    }
    const start = m.index;
    const box = measure(input, refs.slice(start, start + text.length));
    if (!box) {
      invalid.push({ text, page: input.page });
      continue;
    }
    anchors.push({ text, type, role: inner[2], page: input.page, ...box });
  }
  return { anchors, invalid };
}

/** Retângulo (normalizado) ocupado pelos caracteres, na página visível. */
function measure(
  input: PageTextInput,
  chars: CharRef[],
): { x: number; y: number; width: number; height: number; baseline: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const baseYs: number[] = [];
  for (const c of chars) {
    const it = input.items[c.item];
    const [a, b, cc, d, e, f] = it.transform;
    const dirLen = Math.hypot(a, b);
    const size = Math.hypot(cc, d);
    if (!(dirLen > 0) || !(size > 0) || !(it.width >= 0) || it.str.length === 0) return null;
    const dx = a / dirLen;
    const dy = b / dirLen;
    const ux = cc / size;
    const uy = d / size;
    const t0 = (it.width * c.index) / it.str.length;
    const t1 = (it.width * (c.index + 1)) / it.str.length;
    for (const t of [t0, t1]) {
      const bx = e + dx * t;
      const by = f + dy * t;
      const [vx0, vy0] = input.toView(bx, by);
      const [vx1, vy1] = input.toView(bx + ux * size, by + uy * size);
      xs.push(vx0, vx1);
      ys.push(vy0, vy1);
      baseYs.push(vy0);
    }
  }
  if (xs.length === 0) return null;
  const minX = clamp01(Math.min(...xs) / input.viewWidth);
  const maxX = clamp01(Math.max(...xs) / input.viewWidth);
  const minY = clamp01(Math.min(...ys) / input.viewHeight);
  const maxY = clamp01(Math.max(...ys) / input.viewHeight);
  const baseline = clamp01(baseYs.reduce((s, v) => s + v, 0) / baseYs.length / input.viewHeight);
  if (![minX, maxX, minY, maxY, baseline].every(Number.isFinite)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, baseline };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function sized(type: FieldType, viewWidth: number, viewHeight: number): { width: number; height: number } {
  const s = FIELD_SIZE_PT[type];
  return { width: Math.min(1, s.width / viewWidth), height: Math.min(1, s.height / viewHeight) };
}

function fit(box: NormalizedBox): NormalizedBox {
  return {
    ...box,
    x: Math.min(Math.max(0, box.x), 1 - box.width),
    y: Math.min(Math.max(0, box.y), 1 - box.height),
  };
}

/**
 * Campo gerado por uma âncora:
 * - assinatura/rubrica: começa na esquerda do marcador e fica apoiada na linha de base dele,
 *   descendo um pouco (SIGNATURE_OVERLAP) para "encostar" na linha de assinatura logo abaixo;
 * - nome/data: centralizado verticalmente no marcador (o texto ocupa o lugar do marcador).
 */
export function fieldFromAnchor(anchor: FoundAnchor, viewWidth: number, viewHeight: number): NormalizedBox {
  const { width, height } = sized(anchor.type, viewWidth, viewHeight);
  const upright = anchor.type === FieldType.SIGNATURE || anchor.type === FieldType.INITIALS;
  const y = upright ? anchor.baseline - height * (1 - SIGNATURE_OVERLAP) : anchor.y + anchor.height / 2 - height / 2;
  return fit({ x: anchor.x, y, width, height });
}

/** Rubrica automática no canto da página; `slot` empilha papéis no mesmo canto. */
export function cornerInitials(corner: PageCorner, slot: number, viewWidth: number, viewHeight: number): NormalizedBox {
  const { width, height } = sized(FieldType.INITIALS, viewWidth, viewHeight);
  const mx = CORNER_MARGIN_PT / viewWidth;
  const my = CORNER_MARGIN_PT / viewHeight;
  const step = slot * (width + CORNER_GAP_PT / viewWidth);
  const right = corner === PageCorner.BOTTOM_RIGHT || corner === PageCorner.TOP_RIGHT;
  const bottom = corner === PageCorner.BOTTOM_RIGHT || corner === PageCorner.BOTTOM_LEFT;
  return fit({
    x: right ? 1 - mx - width - step : mx + step,
    y: bottom ? 1 - my - height : my,
    width,
    height,
  });
}

// ───────────── Aplicação de um modelo a um conjunto de documentos ─────────────

export interface TemplateRoleRule {
  key: string;
  initialsAllPages: boolean;
  initialsCorner: PageCorner;
}

export interface ScannedDocument<Ref> {
  ref: Ref;
  pages: Array<{ page: number; viewWidth: number; viewHeight: number; scan: AnchorScan }>;
}

export interface PlannedField<Ref> extends NormalizedBox {
  ref: Ref;
  role: string;
  type: FieldType;
  page: number;
  source: 'anchor' | 'all_pages';
}

export interface TemplatePlan<Ref> {
  fields: PlannedField<Ref>[];
  anchors: Array<FoundAnchor & { ref: Ref }>;
  /** Papéis do modelo sem nenhuma âncora de assinatura (o envio deve ser recusado). */
  missingSignature: string[];
  /** Papéis citados em âncoras mas inexistentes no modelo. */
  unknownRoles: string[];
  invalid: Array<InvalidAnchor & { ref: Ref }>;
}

export function planTemplateFields<Ref>(roles: TemplateRoleRule[], docs: ScannedDocument<Ref>[]): TemplatePlan<Ref> {
  const roleKeys = new Set(roles.map((r) => r.key));
  const fields: PlannedField<Ref>[] = [];
  const anchors: Array<FoundAnchor & { ref: Ref }> = [];
  const invalid: Array<InvalidAnchor & { ref: Ref }> = [];
  const unknown = new Set<string>();
  const signed = new Set<string>();

  for (const doc of docs) {
    for (const p of doc.pages) {
      invalid.push(...p.scan.invalid.map((i) => ({ ...i, ref: doc.ref })));
      const anchoredInitials = new Set<string>();
      for (const a of p.scan.anchors) {
        anchors.push({ ...a, ref: doc.ref });
        if (!roleKeys.has(a.role)) {
          unknown.add(a.role);
          continue;
        }
        if (a.type === FieldType.SIGNATURE) signed.add(a.role);
        if (a.type === FieldType.INITIALS) anchoredInitials.add(a.role);
        fields.push({ ref: doc.ref, role: a.role, type: a.type, page: p.page, source: 'anchor', ...fieldFromAnchor(a, p.viewWidth, p.viewHeight) });
      }
      // Rubrica em todas as páginas (exceto onde o PDF já tem âncora de rubrica do papel).
      const slots = new Map<PageCorner, number>();
      for (const r of roles) {
        if (!r.initialsAllPages || anchoredInitials.has(r.key)) continue;
        const slot = slots.get(r.initialsCorner) ?? 0;
        slots.set(r.initialsCorner, slot + 1);
        fields.push({
          ref: doc.ref,
          role: r.key,
          type: FieldType.INITIALS,
          page: p.page,
          source: 'all_pages',
          ...cornerInitials(r.initialsCorner, slot, p.viewWidth, p.viewHeight),
        });
      }
    }
  }

  return {
    fields,
    anchors,
    missingSignature: roles.map((r) => r.key).filter((k) => !signed.has(k)),
    unknownRoles: [...unknown].sort(),
    invalid,
  };
}
