export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Remove caracteres de controle e limita tamanho (nomes de arquivo, títulos). */
export function cleanText(input: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * Fontes padrão do PDF (Helvetica) usam codificação WinAnsi (Latin-1 + alguns símbolos).
 * Caracteres fora desse conjunto são substituídos para não quebrar a geração do PDF.
 */
export function toWinAnsiSafe(input: string): string {
  const extra = new Set(['€', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', 'Ž', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', 'ž', 'Ÿ']);
  let out = '';
  for (const ch of input.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || extra.has(ch)) out += ch;
    else if (ch === '\n' || ch === '\t') out += ' ';
    else out += '?';
  }
  return out;
}

/** Valida CPF (dígitos verificadores). Retorna somente dígitos ou null. */
export function normalizeCpf(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return null;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  if (calc(9) !== Number(d[9]) || calc(10) !== Number(d[10])) return null;
  return d;
}
