/**
 * Telefones em E.164 ("+5524999999999"). Aceita formatos comuns digitados no Brasil:
 * "(24) 99999-9999", "024 99999-9999", "+55 24 99999-9999", "5524999999999".
 * Retorna null se não for possível normalizar com segurança.
 */
export function normalizePhone(raw: string, defaultCountryCode = '55'): string | null {
  const trimmed = raw.trim();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('00')) digits = digits.slice(2);
  if (!international) {
    digits = digits.replace(/^0+/, ''); // prefixo de operadora/DDD com zero
    if (defaultCountryCode === '55') {
      // Nacional brasileiro: DDD (2) + número (8 fixo ou 9 celular).
      if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
      else if (!(digits.startsWith('55') && (digits.length === 12 || digits.length === 13))) return null;
    } else if (!digits.startsWith(defaultCountryCode)) {
      digits = `${defaultCountryCode}${digits}`;
    }
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  if (digits.startsWith('55') && !(digits.length === 12 || digits.length === 13)) return null;
  return `+${digits}`;
}

/** "+5524999991234" → "+55 24 •••••-1234" (exibição/auditoria). */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length >= 12) return `+55 ${digits.slice(2, 4)} •••••-${digits.slice(-4)}`;
  return `+${digits.slice(0, 2)} •••-${digits.slice(-4)}`;
}
