import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { Errors } from '../../common/errors/app-error';

// Faixas não roteáveis/internas: impede SSRF contra a rede interna e metadados de nuvem.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  // ::ffff:0:0/96 NÃO entra aqui: o BlockList do Node o equipara a todo o espaço IPv4.
  // Endereços IPv4 mapeados são convertidos e checados como IPv4 em isBlockedAddress.
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(input: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(input);
  const address = mapped ? mapped[1] : input;
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return true;
}

/**
 * Valida URL de webhook: HTTPS (HTTP apenas quando destinos privados são permitidos em dev),
 * sem credenciais embutidas, e todos os IPs resolvidos devem ser públicos.
 * Observação: existe janela residual de DNS rebinding entre a resolução e a conexão
 * (documentado em docs/webhooks.md); recomendada egress policy no ambiente de produção.
 */
export async function assertSafeWebhookUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Errors.validation('URL de webhook inválida.');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw Errors.validation('A URL do webhook deve usar HTTPS.');
  }
  if (url.username || url.password) throw Errors.validation('A URL do webhook não pode conter credenciais.');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw Errors.validation('Não foi possível resolver o host do webhook.');
    }
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw Errors.validation('O destino do webhook aponta para um endereço não permitido.');
  }
  return url;
}
