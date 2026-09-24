import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { LegalTextKind, type LegalTextVersion } from '../../generated/prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { sha256Hex } from '../../common/crypto/crypto.util';
import { CURRENT_SIGNATURE_CONSENT_VERSION, LEGAL_TEXTS } from './legal-texts';

@Injectable()
export class LegalService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Legal');

  constructor(private readonly prisma: PrismaService) {}

  /** Registra versões novas e garante que versões publicadas não foram alteradas. */
  async onApplicationBootstrap(): Promise<void> {
    for (const def of LEGAL_TEXTS) {
      const sha256 = sha256Hex(def.content);
      const existing = await this.prisma.legalTextVersion.findUnique({
        where: { kind_version: { kind: def.kind, version: def.version } },
      });
      if (!existing) {
        await this.prisma.legalTextVersion
          .create({ data: { kind: def.kind, version: def.version, content: def.content, sha256 } })
          .catch((err: unknown) => {
            // Outra instância pode ter criado simultaneamente.
            if ((err as { code?: string }).code !== 'P2002') throw err;
          });
        this.logger.log({ event: 'legal_text_registered', kind: def.kind, version: def.version });
      } else if (existing.sha256 !== sha256) {
        throw new Error(
          `Texto legal ${def.kind} v${def.version} foi alterado após publicação. Crie uma nova versão em vez de editar.`,
        );
      }
    }
  }

  async currentSignatureConsent(): Promise<LegalTextVersion> {
    const row = await this.prisma.legalTextVersion.findUnique({
      where: { kind_version: { kind: LegalTextKind.SIGNATURE_CONSENT, version: CURRENT_SIGNATURE_CONSENT_VERSION } },
    });
    if (!row) throw new Error('Texto de consentimento vigente não registrado');
    return row;
  }
}
