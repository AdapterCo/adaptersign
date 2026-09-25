import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { CPF_INDEX_CONTEXT } from './envelope-filters';

const BATCH = 500;

/**
 * Signatários anteriores ao índice cego de CPF têm só o CPF cifrado: calcula o índice na
 * inicialização, em lotes (idempotente — só linhas com cpf_hash nulo). Nunca registra o CPF.
 */
@Injectable()
export class CpfIndexBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger('CpfIndexBackfill');

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  onApplicationBootstrap(): void {
    // Em segundo plano: não atrasa a subida da aplicação.
    void this.run().catch((err: unknown) => this.logger.warn({ event: 'cpf_index_backfill_failed', error: String(err) }));
  }

  async run(): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await this.prisma.signer.findMany({
        where: { cpfEncrypted: { not: null }, cpfHash: null },
        select: { id: true, cpfEncrypted: true },
        take: BATCH,
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        const cpf = this.encryption.decrypt(r.cpfEncrypted!);
        await this.prisma.signer.update({ where: { id: r.id }, data: { cpfHash: this.encryption.hashToken(cpf, CPF_INDEX_CONTEXT) } });
      }
      total += rows.length;
      if (rows.length < BATCH) break;
    }
    if (total > 0) this.logger.log({ event: 'cpf_index_backfilled', count: total });
    return total;
  }
}
