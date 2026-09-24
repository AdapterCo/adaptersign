import { hmacSha256Hex, safeEqual } from '../../common/crypto/crypto.util';

export const WEBHOOK_HEADERS = {
  signature: 'X-Adapter-Signature',
  timestamp: 'X-Adapter-Timestamp',
  eventId: 'X-Adapter-Event-ID',
  eventType: 'X-Adapter-Event-Type',
  attempt: 'X-Adapter-Delivery-Attempt',
} as const;

/**
 * Assinatura HMAC-SHA256 do payload:
 *   X-Adapter-Signature: v1=hex(HMAC_SHA256(secret, `${timestamp}.${eventId}.${rawBody}`))
 * O timestamp e o event id fazem parte do conteúdo assinado (proteção contra replay).
 */
export function signWebhook(secret: string, timestamp: number, eventId: string, rawBody: string): string {
  return `v1=${hmacSha256Hex(secret, `${timestamp}.${eventId}.${rawBody}`)}`;
}

/**
 * Verificação (referência para clientes e testes): confere a assinatura em tempo
 * constante e rejeita timestamps fora da tolerância. O cliente deve ainda
 * descartar event ids já processados.
 */
export function verifyWebhook(
  secret: string,
  headers: { signature: string; timestamp: string; eventId: string },
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  return safeEqual(signWebhook(secret, ts, headers.eventId, rawBody), headers.signature);
}
