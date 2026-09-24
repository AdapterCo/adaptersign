import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';

// Somente primitivas do módulo crypto do Node (OpenSSL). Nenhum algoritmo próprio.

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256Stream(stream: Readable): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest('hex'), size };
}

export function hmacSha256Hex(secret: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Token opaco de alta entropia (256 bits por padrão), seguro para URL. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Código numérico uniforme (sem viés de módulo) gerado por CSPRNG. */
export function randomNumericCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

/** Comparação em tempo constante de strings hex/ASCII de mesmo tamanho. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Serialização JSON canônica e determinística:
 * - chaves de objetos ordenadas lexicograficamente (recursivo);
 * - `undefined` omitido; Date → ISO-8601 UTC; bigint → string.
 * Usada no encadeamento de auditoria — nunca depende da ordem das propriedades.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = normalize(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('canonicalJson: número não finito');
  }
  return value;
}
