import type { EnvelopeStatus, Prisma } from '../../generated/prisma/client';

export type EnvelopeOrigin = 'integration' | 'manual';

/** Contexto do índice cego de CPF (HMAC com o pepper TOKEN_HASH_SECRET sobre os 11 dígitos). */
export const CPF_INDEX_CONTEXT = 'cpf_index';

export interface EnvelopeFilters {
  status?: EnvelopeStatus;
  search?: string;
  externalRef?: string;
  origin?: EnvelopeOrigin;
  templateId?: string;
  /** Id do representante (vendedor) no sistema de origem. */
  representative?: string;
  from?: string;
  to?: string;
}

/**
 * Filtros da listagem de envelopes (sempre dentro da organização). Os CPFs chegam como índices
 * cegos já calculados: `filter` (filtro explícito) e `fromSearch` (busca livre que é um CPF válido).
 */
export function buildEnvelopeWhere(
  organizationId: string,
  f: EnvelopeFilters,
  cpf: { filter?: string | null; fromSearch?: string | null } = {},
): Prisma.EnvelopeWhereInput {
  const and: Prisma.EnvelopeWhereInput[] = [{ organizationId }];
  if (f.status) and.push({ status: f.status });
  if (f.externalRef) and.push({ externalRef: f.externalRef });
  if (f.origin === 'integration') and.push({ createdByApiKeyId: { not: null } });
  if (f.origin === 'manual') and.push({ createdByApiKeyId: null });
  if (f.templateId) and.push({ templateId: f.templateId });
  if (f.representative) and.push({ signers: { some: { externalId: f.representative, representing: { not: null } } } });
  if (f.from || f.to) {
    and.push({ createdAt: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } });
  }
  if (cpf.filter !== undefined) {
    // CPF informado mas inválido/sem correspondência → nenhum resultado (nunca "todos").
    and.push(cpf.filter ? { signers: { some: { cpfHash: cpf.filter } } } : { id: { in: [] } });
  }
  const search = f.search?.trim();
  if (search) {
    const or: Prisma.EnvelopeWhereInput[] = [
      { title: { contains: search, mode: 'insensitive' } },
      { publicValidationCode: { equals: search.toUpperCase() } },
      { externalRef: { equals: search } },
      { signers: { some: { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search.toLowerCase() } }] } } },
      { documents: { some: { documentVersion: { document: { title: { contains: search, mode: 'insensitive' } } } } } },
    ];
    if (cpf.fromSearch) or.push({ signers: { some: { cpfHash: cpf.fromSearch } } });
    and.push({ OR: or });
  }
  return { AND: and };
}
