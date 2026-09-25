import type { Tx } from '../../infra/prisma/prisma.service';
import type { EncryptionService } from '../../common/crypto/encryption.service';
import { randomToken } from '../../common/crypto/crypto.util';

/**
 * Token individual do link /sign/{token}: 256 bits, imprevisível, não revela IDs,
 * com validade e revogável. Somente o hash (HMAC com pepper) é persistido.
 * O contexto do hash precisa coincidir com SigningService.openSession.
 */
export async function issueSignerAccessToken(
  tx: Tx,
  encryption: EncryptionService,
  signerId: string,
  envelopeExpiresAt: Date | null,
  ttlDays: number,
  channel: 'EMAIL' | 'WHATSAPP' | 'API' = 'EMAIL',
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const maxExpiry = Date.now() + ttlDays * 24 * 3600 * 1000;
  const expiresAt = new Date(envelopeExpiresAt ? Math.min(envelopeExpiresAt.getTime(), maxExpiry) : maxExpiry);
  await tx.signerAccessToken.create({
    data: { signerId, tokenHash: encryption.hashToken(token, 'signer_access'), expiresAt, channel },
  });
  return { token, expiresAt };
}
