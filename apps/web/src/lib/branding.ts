// Branding centralizado: nenhum componente escreve o nome do produto diretamente.
export const branding = {
  name: process.env.NEXT_PUBLIC_BRAND_NAME ?? 'Adapter Sign',
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? null,
};
