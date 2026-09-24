import { UserTokenPurpose } from '../../generated/prisma/client';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { EncryptionService } from '../../common/crypto/encryption.service';
import { randomToken } from '../../common/crypto/crypto.util';

const TTL_MS: Record<UserTokenPurpose, number> = {
  EMAIL_VERIFICATION: 24 * 3600 * 1000,
  PASSWORD_RESET: 3600 * 1000,
};

/**
 * Emite token de uso único para e-mail de verificação/redefinição.
 * Somente o hash é persistido; tokens anteriores do mesmo propósito são invalidados.
 * O contexto do hash precisa coincidir com AuthService.consumeUserToken.
 */
export async function issueUserToken(
  prisma: PrismaService,
  encryption: EncryptionService,
  userId: string,
  purpose: UserTokenPurpose,
): Promise<string> {
  const raw = randomToken(32);
  await prisma.tx(async (tx) => {
    await tx.userToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
    await tx.userToken.create({
      data: { userId, purpose, tokenHash: encryption.hashToken(raw, `user_token:${purpose}`), expiresAt: new Date(Date.now() + TTL_MS[purpose]) },
    });
  });
  return raw;
}
