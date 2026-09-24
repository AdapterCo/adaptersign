import { randomInt } from 'node:crypto';

// Alfabeto Crockford Base32 (sem I, L, O, U) — legível e sem ambiguidade.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Gera código público não previsível, ex.: ADP-8F7K-29QM-X82P (60 bits de entropia). */
export function generateValidationCode(prefix: string): string {
  const groups: string[] = [];
  for (let g = 0; g < 3; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
    groups.push(s);
  }
  return `${prefix}-${groups.join('-')}`;
}

/** Normaliza entrada do usuário (espaços, minúsculas, O→0, I/L→1). */
export function normalizeValidationCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
  const [prefix, ...rest] = cleaned.split('-');
  const body = rest.join('-').replace(/O/g, '0').replace(/[IL]/g, '1');
  return rest.length ? `${prefix}-${body}` : cleaned;
}

export function isValidationCodeFormat(code: string): boolean {
  return /^[A-Z]{2,5}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code);
}
