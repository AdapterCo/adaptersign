// Formatos das respostas da API usados por mais de uma página.

export interface DocumentRow {
  id: string;
  title: string;
  originalFilename: string;
  status: 'ACTIVE' | 'LOCKED';
  createdAt: string;
  latestVersion: { id: string; versionNumber: number; filename: string; sizeBytes: number; pageCount: number; sha256: string } | null;
  envelopes: Array<{ id: string; title: string; status: string }>;
}

export interface EnvelopeDetail {
  id: string;
  title: string;
  message: string | null;
  status: string;
  signingMode: 'PARALLEL' | 'SEQUENTIAL';
  validationCode: string | null;
  expiresAt: string | null;
  reminderIntervalHours: number | null;
  createdAt: string;
  completedAt: string | null;
  cancelReason: string | null;
  finalizing: boolean;
  documents: Array<{
    id: string;
    documentId: string;
    versionId: string;
    filename: string;
    pageCount: number;
    originalSha256: string;
    finalSha256: string | null;
    finalAvailable: boolean;
  }>;
  signers: Array<{
    id: string;
    name: string;
    email: string;
    cpf: string | null;
    role: string;
    signingGroup: number;
    status: string;
    required: boolean;
    authMethod: string;
    authMethodLabel: string;
    signedAt: string | null;
    declineReason: string | null;
  }>;
  fields: EnvelopeField[];
  evidenceReport: { sha256: string; generatedAt: string } | null;
}

export type FieldType = 'SIGNATURE' | 'INITIALS' | 'NAME' | 'DATE';

export type PageCorner = 'BOTTOM_RIGHT' | 'BOTTOM_LEFT' | 'TOP_RIGHT' | 'TOP_LEFT';

export interface TemplateRole {
  key: string;
  label: string;
  signingGroup: number;
  isCompany: boolean;
  initialsAllPages: boolean;
  initialsCorner: PageCorner;
}

export interface Template {
  id: string;
  key: string;
  name: string;
  description: string | null;
  signingMode: 'SEQUENTIAL' | 'PARALLEL';
  createdAt: string;
  updatedAt: string;
  roles: TemplateRole[];
}

/** Pendências da busca de âncoras (modelo x PDF). */
export interface AnchorIssues {
  missingSignature: string[];
  unknownRoles: string[];
  invalid: Array<{ text: string; page: number }>;
}

export interface TemplateTestResult extends AnchorIssues {
  ok: boolean;
  pages: Array<{ page: number; width: number; height: number }>;
  anchors: Array<{ text: string; type: FieldType; role: string; page: number; x: number; y: number; width: number; height: number }>;
  fields: Array<{ role: string; type: FieldType; page: number; x: number; y: number; width: number; height: number; source: 'anchor' | 'all_pages' }>;
}

/** Coordenadas normalizadas (0..1), origem no canto superior esquerdo da página exibida. */
export interface EnvelopeField {
  id?: string;
  envelopeDocumentId: string;
  signerId: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
