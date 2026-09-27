import { buildEnvelopeWhere } from '../../src/modules/envelopes/envelope-filters';

const ORG = 'org-1';

describe('buildEnvelopeWhere', () => {
  const base = { organizationId: ORG, deletedAt: null, archivedAt: null };

  it('sempre restringe à organização e esconde rascunhos excluídos e arquivados', () => {
    expect(buildEnvelopeWhere(ORG, {})).toEqual({ AND: [base] });
  });

  it('arquivados só quando pedidos', () => {
    expect(buildEnvelopeWhere(ORG, { archived: 'true' })).toEqual({ AND: [{ ...base, archivedAt: { not: null } }] });
  });

  it('origem, modelo, vendedor e período', () => {
    const w = buildEnvelopeWhere(ORG, {
      origin: 'integration',
      templateId: 't1',
      representative: 'usuario-17',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.000Z',
    });
    expect(w.AND).toEqual([
      base,
      { createdByApiKeyId: { not: null } },
      { templateId: 't1' },
      { signers: { some: { externalId: 'usuario-17', representing: { not: null } } } },
      { createdAt: { gte: new Date('2026-09-01T00:00:00.000Z'), lte: new Date('2026-09-30T23:59:59.000Z') } },
    ]);
    expect(buildEnvelopeWhere(ORG, { origin: 'manual' }).AND).toContainEqual({ createdByApiKeyId: null });
  });

  it('CPF pelo índice cego; CPF sem correspondência não devolve tudo', () => {
    expect(buildEnvelopeWhere(ORG, {}, { filter: 'hash-1' }).AND).toContainEqual({ signers: { some: { cpfHash: 'hash-1' } } });
    expect(buildEnvelopeWhere(ORG, {}, { filter: null }).AND).toContainEqual({ id: { in: [] } });
  });

  it('busca livre inclui referência e, se for CPF, o índice cego', () => {
    const w = buildEnvelopeWhere(ORG, { search: 'venda-123' }, { fromSearch: 'hash-2' });
    const or = (w.AND as Array<{ OR?: unknown[] }>).find((c) => c.OR)!.OR!;
    expect(or).toContainEqual({ externalRef: { equals: 'venda-123' } });
    expect(or).toContainEqual({ signers: { some: { cpfHash: 'hash-2' } } });
  });
});
