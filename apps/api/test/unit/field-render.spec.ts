import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { buildFinalDocument } from '../../src/modules/evidence/final-document.builder';
import type { Branding } from '../../src/config/branding';

const brand: Branding = { name: 'Marca de Teste', primaryColor: '#1F4FD1', appUrl: 'https://app.exemplo.test', validationCodePrefix: 'ADP' };
// PNG 1x1 válido (assinatura desenhada fictícia).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function contractPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText('Contrato fictício — página 1', { x: 72, y: 760, size: 12, font });
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText('______________________  (loja)', { x: 148, y: 760, size: 12, font });
  p2.drawText('______________________  (cliente)', { x: 148, y: 700, size: 12, font });
  const p3 = doc.addPage([595.28, 841.89]);
  p3.setRotation(degrees(90)); // página digitalizada de lado
  return Buffer.from(await doc.save());
}

describe('documento final com campos posicionados', () => {
  it('desenha assinatura (digitada e desenhada), rubrica, nome e data sem alterar a contagem de páginas originais', async () => {
    const signedAt = new Date('2026-09-25T13:00:00.000Z');
    const bytes = await buildFinalDocument(await contractPdf(), {
      brand,
      timezone: 'America/Sao_Paulo',
      validationCode: 'ADP-8F7K-29QM-X82P',
      envelopeTitle: 'Contrato de teste',
      filename: 'contrato.pdf',
      originalSha256: 'a'.repeat(64),
      signers: [
        {
          name: 'Loja Fictícia Ltda',
          email: 'l***a@e****.test',
          role: 'SIGNER',
          authentication: 'Código (OTP) enviado por e-mail',
          signedAt,
          method: 'TYPED',
          typedName: 'Maria Representante',
          image: null,
          fields: [
            { type: 'SIGNATURE', page: 2, x: 0.25, y: 0.05, width: 0.5, height: 0.05 },
            { type: 'INITIALS', page: 1, x: 0.85, y: 0.9, width: 0.1, height: 0.04 },
          ],
        },
        {
          name: 'João Cliente Exemplo',
          email: 'j***o@e****.test',
          role: 'SIGNER',
          authentication: 'Código (OTP) enviado por e-mail',
          signedAt,
          method: 'DRAWN',
          typedName: null,
          image: PNG,
          fields: [
            { type: 'SIGNATURE', page: 2, x: 0.25, y: 0.12, width: 0.5, height: 0.05 },
            { type: 'NAME', page: 2, x: 0.25, y: 0.18, width: 0.5, height: 0.025 },
            { type: 'DATE', page: 2, x: 0.25, y: 0.21, width: 0.3, height: 0.025 },
            { type: 'SIGNATURE', page: 3, x: 0.1, y: 0.1, width: 0.4, height: 0.08 }, // página girada
            { type: 'SIGNATURE', page: 99, x: 0.1, y: 0.1, width: 0.4, height: 0.08 }, // ignorado (fora do documento)
          ],
        },
      ],
    });
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(4); // 3 originais + página de assinaturas
    expect(out.getPage(2).getRotation().angle).toBe(90); // rotação original preservada
  });
});
