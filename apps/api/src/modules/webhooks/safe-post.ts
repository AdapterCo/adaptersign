import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isBlockedAddress } from './url-safety';

/**
 * Resolve o host e recusa QUALQUER endereço interno no momento da conexão. Como a validação
 * acontece dentro da própria conexão, não há janela de DNS rebinding entre "validar" e "conectar".
 */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 4);
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      const blocked = Object.assign(new Error(`Destino não permitido: ${hostname}`), { code: 'EBLOCKEDADDRESS' });
      return callback(blocked, '', 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * POST sem seguir redirecionamentos e sem ler o corpo da resposta (pode conter dados do cliente).
 * Com `allowPrivate` (somente desenvolvimento) usa a resolução padrão.
 */
export function safePost(
  url: URL,
  headers: Record<string, string>,
  body: string,
  opts: { timeoutMs: number; allowPrivate: boolean },
): Promise<{ status: number }> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
        timeout: opts.timeoutMs,
        ...(opts.allowPrivate ? {} : { lookup: safeLookup }),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Tempo de resposta excedido'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end(body);
  });
}
