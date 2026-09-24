// Mascaramento para exibição pública/relatórios (LGPD: minimização).

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const maskedLocal = local.length <= 2 ? `${local[0]}*` : `${local[0]}${'*'.repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}`;
  const maskedHost = `${host[0]}${'*'.repeat(Math.max(Math.min(host.length - 1, 6), 1))}`;
  return `${maskedLocal}@${maskedHost}${tld}`;
}

export function maskCpf(last2: string | null | undefined): string | null {
  if (!last2) return null;
  return `***.***.***-${last2}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const parts = v4.split('.');
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  const groups = ip.split(':').filter((g) => g.length > 0);
  return `${groups.slice(0, 2).join(':')}:****`;
}

export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts
    .slice(1)
    .map((p) => `${p[0]}.`)
    .join(' ')}`;
}
