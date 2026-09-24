import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { branding } from '@/lib/branding';

export const metadata: Metadata = {
  title: { default: branding.name, template: `%s · ${branding.name}` },
  description: 'Assinatura eletrônica de documentos com trilha de auditoria verificável.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
