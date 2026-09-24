import { PDFDocument, StandardFonts } from 'pdf-lib';
import { hasPdfExtension, hasPdfMagic, inspectPdf } from '../../src/common/util/pdf-validation';
import { buildEvidenceReport } from '../../src/modules/evidence/evidence-report.builder';
import { buildFinalDocument } from '../../src/modules/evidence/final-document.builder';
import type { Branding } from '../../src/config/branding';

const brand: Branding = { name: 'Marca de Teste', primaryColor: '#1F4FD1', appUrl: 'https://app.exemplo.test', validationCodePrefix: 'ADP' };

async function samplePdf(pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage().drawText(`Contrato fictício — página ${i + 1}`, { x: 50, y: 700, size: 14, font });
  return Buffer.from(await doc.save());
}

describe('validação de upload de PDF', () => {
  it('aceita PDF processável e conta páginas', async () => {
    const pdf = await samplePdf(3);
    expect(hasPdfMagic(pdf)).toBe(true);
    await expect(inspectPdf(pdf)).resolves.toEqual({ pageCount: 3 });
  });

  it('rejeita arquivo com magic bytes inválidos (Content-Type falso)', async () => {
    await expect(inspectPdf(Buffer.from('MZ\x90\x00 executável disfarçado'))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejeita PDF estruturalmente corrompido', async () => {
    await expect(inspectPdf(Buffer.from('%PDF-1.7\n lixo sem estrutura'))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('valida extensão', () => {
    expect(hasPdfExtension('contrato.PDF')).toBe(true);
    expect(hasPdfExtension('contrato.pdf.exe')).toBe(false);
  });
});

describe('geração de documentos de evidência', () => {
  const signedAt = new Date('2026-09-23T14:32:00.000Z');

  it('documento final preserva páginas originais e acrescenta página de assinaturas', async () => {
    const original = await samplePdf(2);
    const bytes = await buildFinalDocument(original, {
      brand,
      timezone: 'America/Sao_Paulo',
      validationCode: 'ADP-8F7K-29QM-X82P',
      envelopeTitle: 'Contrato de prestação de serviços',
      filename: 'contrato.pdf',
      originalSha256: 'a'.repeat(64),
      signers: [
        { name: 'Daniel Exemplo', email: 'd****l@e****.com', role: 'SIGNER', authentication: 'Código (OTP) enviado por e-mail', signedAt, method: 'TYPED', typedName: 'Daniel Exemplo', image: null },
      ],
    });
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(3);
  });

  it('relatório de evidências é um PDF válido', async () => {
    const bytes = await buildEvidenceReport({
      brand,
      timezone: 'America/Sao_Paulo',
      envelope: {
        id: '00000000-0000-0000-0000-000000000001',
        title: 'Contrato',
        validationCode: 'ADP-8F7K-29QM-X82P',
        organizationName: 'Empresa Fictícia',
        createdAt: signedAt,
        activatedAt: signedAt,
        completedAt: signedAt,
        signingMode: 'SEQUENTIAL',
      },
      documents: [{ filename: 'contrato.pdf', pageCount: 2, versionId: 'v1', originalSha256: 'a'.repeat(64), finalSha256: 'b'.repeat(64) }],
      signers: [
        {
          name: 'João Exemplo',
          email: 'j***o@e****.com',
          cpf: null,
          role: 'SIGNER',
          authentication: 'Código (OTP) enviado por e-mail',
          authenticatedAt: signedAt,
          signedAt,
          signatureMethod: 'DRAWN',
          ip: '203.0.*.*',
          userAgent: 'Mozilla/5.0',
          consentVersion: '1.0',
          consentSha256: 'c'.repeat(64),
          signatureId: 'sig-1',
        },
      ],
      events: Array.from({ length: 60 }, (_, i) => ({ sequence: i + 1, occurredAt: signedAt, label: 'Evento', actor: 'Sistema', eventHash: 'd'.repeat(64) })),
      chain: { valid: true, count: 60, headHash: 'd'.repeat(64) },
    });
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBeGreaterThan(1);
  });
});
