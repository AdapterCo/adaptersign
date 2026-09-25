import { Colors, hexToRgb, PdfWriter } from './pdf-writer';
import type { Branding } from '../../config/branding';

export interface EvidenceReportData {
  brand: Branding;
  timezone: string;
  envelope: {
    id: string;
    title: string;
    validationCode: string;
    organizationName: string;
    createdAt: Date;
    activatedAt: Date | null;
    completedAt: Date;
    signingMode: string;
  };
  documents: Array<{ filename: string; pageCount: number; versionId: string; originalSha256: string; finalSha256: string }>;
  signers: Array<{
    name: string;
    email: string; // já mascarado
    cpf: string | null; // já mascarado
    role: string;
    authentication: string;
    authenticatedAt: Date | null;
    signedAt: Date;
    signatureMethod: string;
    ip: string | null; // já mascarado
    userAgent: string | null;
    consentVersion: string;
    consentSha256: string;
    /** Texto aceito: consentimento do signatário ou autorização da empresa (integração). */
    consentLabel: string;
    /** Assinatura pela integração: em nome de quem, atestada por quem e sob qual autorização. */
    representation: string | null;
    signatureId: string;
  }>;
  events: Array<{ sequence: number; occurredAt: Date; label: string; actor: string; eventHash: string }>;
  chain: { valid: boolean; count: number; headHash: string };
}

function fmt(d: Date | null, tz: string): string {
  if (!d) return '—';
  const local = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
  return `${local} (${tz}) · ${d.toISOString()}`;
}

const ROLE_LABEL: Record<string, string> = { SIGNER: 'Signatário', APPROVER: 'Aprovador', WITNESS: 'Testemunha' };
const METHOD_LABEL: Record<string, string> = { TYPED: 'Nome digitado', DRAWN: 'Assinatura desenhada' };

/**
 * Relatório de evidências (seção 26). Registra EXATAMENTE os métodos, autenticações
 * e evidências existentes — sem conclusões jurídicas absolutas.
 */
export async function buildEvidenceReport(data: EvidenceReportData): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  const { brand, timezone: tz } = data;
  const brandColor = hexToRgb(brand.primaryColor);

  w.doc.setTitle(`Relatório de evidências — ${data.envelope.validationCode}`);
  w.doc.setProducer(brand.name);
  w.doc.setCreator(brand.name);
  w.doc.setCreationDate(data.envelope.completedAt);

  w.text(brand.name, { size: 12, font: w.bold, color: brandColor, gap: 6 });
  w.text('CERTIFICADO / RELATÓRIO DE ASSINATURAS', { size: 16, font: w.bold, gap: 4 });
  w.text(`Código de validação: ${data.envelope.validationCode}`, { size: 11, font: w.bold, gap: 2 });
  w.text(`Verifique em: ${brand.appUrl}/verify`, { size: 9, color: Colors.muted, gap: 10 });

  w.heading('Envelope');
  w.keyValue('Título', data.envelope.title);
  w.keyValue('Remetente (organização)', data.envelope.organizationName);
  w.keyValue('Identificador interno', data.envelope.id);
  w.keyValue('Criado em', fmt(data.envelope.createdAt, tz));
  w.keyValue('Enviado para assinatura em', fmt(data.envelope.activatedAt, tz));
  w.keyValue('Finalizado em', fmt(data.envelope.completedAt, tz));
  w.keyValue('Ordem de assinatura', data.envelope.signingMode === 'SEQUENTIAL' ? 'Sequencial' : 'Paralela');

  w.heading('Documentos');
  data.documents.forEach((d, i) => {
    w.text(`${i + 1}. ${d.filename} (${d.pageCount} página${d.pageCount > 1 ? 's' : ''})`, { font: w.bold, gap: 3 });
    w.keyValue('SHA-256 do documento original', d.originalSha256, 12);
    w.keyValue('SHA-256 do documento final (com página de assinaturas)', d.finalSha256, 12);
    w.keyValue('Versão', d.versionId, 12);
  });

  w.heading('Signatários');
  data.signers.forEach((s, i) => {
    w.ensure(150);
    w.text(`${i + 1}. ${s.name}`, { size: 11, font: w.bold, gap: 3 });
    w.keyValue('Papel', ROLE_LABEL[s.role] ?? s.role, 12);
    w.keyValue('E-mail', s.email, 12);
    if (s.cpf) w.keyValue('CPF', s.cpf, 12);
    w.keyValue('Autenticação', `${s.authentication}${s.authenticatedAt ? ` — ${fmt(s.authenticatedAt, tz)}` : ''}`, 12);
    w.keyValue('Assinado em', fmt(s.signedAt, tz), 12);
    w.keyValue('Representação visual', METHOD_LABEL[s.signatureMethod] ?? s.signatureMethod, 12);
    if (s.representation) w.keyValue('Representação', s.representation, 12);
    w.keyValue('Aceite', `${s.consentLabel} v${s.consentVersion} (SHA-256 ${s.consentSha256})`, 12);
    w.keyValue('Rede (auxiliar, não prova identidade)', `IP ${s.ip ?? '—'} · ${s.userAgent ?? '—'}`, 12);
    w.keyValue('Registro da assinatura', s.signatureId, 12);
    w.space(4);
  });

  w.heading('Trilha de eventos');
  for (const e of data.events) {
    w.ensure(30);
    w.text(`${e.sequence}. ${e.label} — ${e.actor}`, { size: 9, font: w.bold, gap: 0 });
    w.text(`${fmt(e.occurredAt, tz)} · hash ${e.eventHash}`, { size: 7.5, color: Colors.muted, indent: 12, gap: 4 });
  }

  w.heading('Integridade da trilha de auditoria');
  w.text(
    data.chain.valid
      ? `Encadeamento criptográfico VERIFICADO: ${data.chain.count} eventos, cada um contendo o SHA-256 do anterior.`
      : 'INTEGRIDADE NÃO CONFIRMADA: o encadeamento de eventos apresentou divergência.',
    { font: w.bold, color: data.chain.valid ? Colors.ok : Colors.bad, gap: 3 },
  );
  w.keyValue('Hash do último evento considerado', data.chain.headHash);

  w.heading('Observações');
  w.text(
    'Este relatório descreve tecnicamente os mecanismos utilizados neste processo: identificação informada pelo remetente, ' +
      'método de autenticação, manifestação de vontade (aceite versionado), horários registrados pelo servidor (UTC), ' +
      'hashes SHA-256 dos documentos e o encadeamento criptográfico da trilha de eventos. A representação visual da ' +
      'assinatura não constitui, isoladamente, o mecanismo de confiança. Endereço IP e navegador são evidências auxiliares ' +
      'e não comprovam identidade. Este documento não constitui assinatura qualificada ICP-Brasil nem declara validade ' +
      'jurídica universal; a avaliação jurídica depende do contexto e da legislação aplicável.',
    { size: 8.5, color: Colors.muted },
  );

  w.footer((i, total) => `${brand.name} · Relatório de evidências · ${data.envelope.validationCode} · Página ${i} de ${total}`);
  return w.doc.save({ useObjectStreams: false });
}
