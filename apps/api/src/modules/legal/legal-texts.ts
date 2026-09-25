import { LegalTextKind } from '../../generated/prisma/client';

/**
 * Textos versionados. Uma versão publicada NUNCA pode ter o conteúdo alterado
 * (o LegalService recusa iniciar se o hash divergir). Para mudar o texto,
 * crie uma NOVA versão e atualize CURRENT_*.
 *
 * Termos de uso e política de privacidade devem ser redigidos pela área jurídica
 * e adicionados aqui como novas entradas (TERMS / PRIVACY_POLICY) — não há texto
 * genérico inventado para esses documentos.
 */
export interface LegalTextDefinition {
  kind: LegalTextKind;
  version: string;
  content: string;
}

export const LEGAL_TEXTS: readonly LegalTextDefinition[] = [
  {
    kind: LegalTextKind.SIGNATURE_CONSENT,
    version: '1.0',
    content:
      'Li o(s) documento(s) apresentado(s) e concordo em assiná-lo(s) eletronicamente. ' +
      'Estou ciente de que esta assinatura eletrônica será registrada juntamente com: ' +
      'minha identificação informada pelo remetente, o método de autenticação utilizado, ' +
      'a data e hora do servidor, o endereço IP e o navegador utilizados, e o hash criptográfico ' +
      '(SHA-256) do(s) documento(s), compondo uma trilha de auditoria verificável.',
  },
  {
    kind: LegalTextKind.COMPANY_SIGNATURE_AUTHORIZATION,
    version: '1.0',
    content:
      'Autorizo que os contratos enviados à plataforma pelas integrações desta empresa (sistemas ' +
      'conectados por chave de API) sejam assinados eletronicamente em nome da empresa, pelo ' +
      'representante (vendedor ou colaborador) identificado pelo sistema de origem em cada contrato. ' +
      'Declaro que o sistema de origem autentica esses representantes e que a empresa responde pelas ' +
      'assinaturas registradas por esse meio. Cada assinatura registrará o representante informado, ' +
      'a integração utilizada, a data e hora do servidor, o endereço IP e o hash criptográfico (SHA-256) ' +
      'do(s) documento(s). Esta autorização pode ser revogada a qualquer momento nas configurações.',
  },
];

export const CURRENT_SIGNATURE_CONSENT_VERSION = '1.0';
export const CURRENT_COMPANY_SIGNATURE_AUTHORIZATION_VERSION = '1.0';
