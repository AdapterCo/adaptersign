import type { AppConfig } from './config';

// Branding centralizado: nenhum módulo deve escrever o nome do produto diretamente.
// White label futuro: resolver por organização (campos brand_* em organizations) quando habilitado.
export interface Branding {
  name: string;
  primaryColor: string;
  supportEmail?: string;
  appUrl: string;
  validationCodePrefix: string;
}

export function brandingFromConfig(config: AppConfig): Branding {
  return {
    name: config.BRAND_NAME,
    primaryColor: config.BRAND_PRIMARY_COLOR,
    supportEmail: config.BRAND_SUPPORT_EMAIL,
    appUrl: config.APP_PUBLIC_URL.replace(/\/+$/, ''),
    validationCodePrefix: config.VALIDATION_CODE_PREFIX,
  };
}
