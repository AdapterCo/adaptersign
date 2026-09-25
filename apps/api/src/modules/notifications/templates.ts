import type { Branding } from '../../config/branding';

// Templates centralizados (seção 34). Nenhum texto de e-mail fica espalhado pelo código.
// Textos pt-BR; estrutura preparada para i18n (chave → função de renderização).

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function layout(brand: Branding, title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(cta.url)}" style="background:${escapeHtml(brand.primaryColor)};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>
       <p style="font-size:12px;color:#5b6475">Se o botão não funcionar, copie e cole este endereço no navegador:<br><span style="word-break:break-all">${escapeHtml(cta.url)}</span></p>`
    : '';
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#1b2333">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px" cellpadding="0" cellspacing="0"><tr><td>
  <p style="font-weight:700;font-size:18px;color:${escapeHtml(brand.primaryColor)};margin:0 0 24px">${escapeHtml(brand.name)}</p>
  <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
  ${bodyHtml}
  ${button}
  <hr style="border:none;border-top:1px solid #e3e7ef;margin:28px 0 16px">
  <p style="font-size:12px;color:#5b6475;margin:0">Mensagem automática enviada por ${escapeHtml(brand.name)}. Não compartilhe links ou códigos recebidos.</p>
  </td></tr></table></td></tr></table></body></html>`;
}

const p = (s: string) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px">${s}</p>`;

export interface SignerInviteCtx {
  signerName: string;
  senderOrg: string;
  envelopeTitle: string;
  message: string | null;
  link: string;
  expiresAt: Date | null;
  reminder: boolean;
}

export interface OtpCtx {
  signerName: string;
  code: string;
  minutes: number;
  envelopeTitle: string;
}

export interface EnvelopeStatusCtx {
  recipientName: string;
  envelopeTitle: string;
  validationCode: string;
  link: string | null;
  reason?: string | null;
  signerName?: string;
}

export interface UserLinkCtx {
  name: string;
  link: string;
  organizationName?: string;
}

/**
 * Mensagens de WhatsApp (texto puro; *negrito* no formato do WhatsApp). Enviadas pelo número
 * central da plataforma — por isso sempre identificam a empresa remetente.
 */
export const WhatsAppTemplates = {
  signer_invite(brand: Branding, c: SignerInviteCtx): string {
    return [
      c.reminder ? `*Lembrete — ${brand.name}*` : `*${brand.name}*`,
      '',
      `Olá, ${c.signerName}!`,
      `${c.senderOrg} enviou o documento *${c.envelopeTitle}* para você assinar eletronicamente.`,
      ...(c.message ? ['', c.message] : []),
      '',
      `Para ler e assinar, acesse: ${c.link}`,
      ...(c.expiresAt ? ['', `Prazo: ${fmtDate(c.expiresAt)} (horário de Brasília).`] : []),
      '',
      'Este link é pessoal. Se você não reconhece este envio, ignore esta mensagem.',
    ].join('\n');
  },
  signer_otp(brand: Branding, c: OtpCtx): string {
    return [
      `*${c.code}* é o seu código de verificação ${brand.name} para assinar *${c.envelopeTitle}*.`,
      '',
      `Válido por ${c.minutes} minutos. Não compartilhe este código com ninguém.`,
    ].join('\n');
  },
  envelope_completed(brand: Branding, c: EnvelopeStatusCtx): string {
    return [
      `*${brand.name}*`,
      '',
      `Olá, ${c.recipientName}! O documento *${c.envelopeTitle}* foi assinado por todos.`,
      `Código de validação: ${c.validationCode}`,
      ...(c.link ? ['', `Baixe a sua via assinada: ${c.link}`] : []),
    ].join('\n');
  },
};

const fmtDate = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

export const EmailTemplates = {
  signer_invite(brand: Branding, c: SignerInviteCtx): RenderedEmail {
    const title = c.reminder ? `Lembrete: documento aguardando sua assinatura` : `Você recebeu um documento para assinar`;
    const lines = [
      `Olá, ${escapeHtml(c.signerName)}.`,
      `<strong>${escapeHtml(c.senderOrg)}</strong> enviou o documento <strong>${escapeHtml(c.envelopeTitle)}</strong> para sua assinatura eletrônica.`,
      ...(c.message ? [`Mensagem do remetente: “${escapeHtml(c.message)}”`] : []),
      ...(c.expiresAt ? [`Prazo para assinatura: ${escapeHtml(fmtDate(c.expiresAt))} (horário de Brasília).`] : []),
      'Este link é pessoal e intransferível.',
    ];
    const text = [
      `Olá, ${c.signerName}.`,
      `${c.senderOrg} enviou o documento "${c.envelopeTitle}" para sua assinatura eletrônica.`,
      ...(c.message ? [`Mensagem do remetente: "${c.message}"`] : []),
      ...(c.expiresAt ? [`Prazo: ${fmtDate(c.expiresAt)} (horário de Brasília).`] : []),
      `Acesse: ${c.link}`,
      'Este link é pessoal e intransferível.',
    ].join('\n\n');
    return {
      subject: `${c.reminder ? 'Lembrete: ' : ''}${c.envelopeTitle} — assinatura solicitada`,
      text,
      html: layout(brand, title, lines.map(p).join(''), { label: 'Revisar e assinar', url: c.link }),
    };
  },

  signer_otp(brand: Branding, c: OtpCtx): RenderedEmail {
    return {
      subject: `Seu código de verificação: ${c.code}`,
      text: `Olá, ${c.signerName}.\n\nSeu código para assinar "${c.envelopeTitle}" é: ${c.code}\n\nEle expira em ${c.minutes} minutos e só pode ser usado uma vez. Se você não solicitou, ignore este e-mail.`,
      html: layout(
        brand,
        'Código de verificação',
        p(`Olá, ${escapeHtml(c.signerName)}.`) +
          p(`Use o código abaixo para confirmar sua identidade e assinar <strong>${escapeHtml(c.envelopeTitle)}</strong>:`) +
          `<p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:20px 0">${escapeHtml(c.code)}</p>` +
          p(`O código expira em ${c.minutes} minutos e só pode ser usado uma vez. Se você não solicitou, ignore este e-mail.`),
      ),
    };
  },

  envelope_completed(brand: Branding, c: EnvelopeStatusCtx): RenderedEmail {
    const body =
      p(`Olá, ${escapeHtml(c.recipientName)}.`) +
      p(`Todas as assinaturas de <strong>${escapeHtml(c.envelopeTitle)}</strong> foram concluídas.`) +
      p(`Código de validação: <strong>${escapeHtml(c.validationCode)}</strong>`) +
      p(`Qualquer pessoa pode verificar a integridade do documento em ${escapeHtml(brand.appUrl)}/verify.`);
    return {
      subject: `Concluído: ${c.envelopeTitle}`,
      text: `Olá, ${c.recipientName}.\n\nTodas as assinaturas de "${c.envelopeTitle}" foram concluídas.\nCódigo de validação: ${c.validationCode}\nVerificação: ${brand.appUrl}/verify${c.link ? `\n\nBaixar documentos: ${c.link}` : ''}`,
      html: layout(brand, 'Documento assinado por todos', body, c.link ? { label: 'Baixar documentos', url: c.link } : undefined),
    };
  },

  envelope_cancelled(brand: Branding, c: EnvelopeStatusCtx): RenderedEmail {
    return {
      subject: `Cancelado: ${c.envelopeTitle}`,
      text: `Olá, ${c.recipientName}.\n\nO processo de assinatura "${c.envelopeTitle}" foi cancelado pelo remetente.${c.reason ? `\nMotivo: ${c.reason}` : ''}\nNenhuma ação é necessária.`,
      html: layout(
        brand,
        'Processo de assinatura cancelado',
        p(`Olá, ${escapeHtml(c.recipientName)}.`) +
          p(`O processo de assinatura <strong>${escapeHtml(c.envelopeTitle)}</strong> foi cancelado pelo remetente.`) +
          (c.reason ? p(`Motivo: ${escapeHtml(c.reason)}`) : '') +
          p('Nenhuma ação é necessária.'),
      ),
    };
  },

  envelope_expired(brand: Branding, c: EnvelopeStatusCtx): RenderedEmail {
    return {
      subject: `Expirado: ${c.envelopeTitle}`,
      text: `Olá, ${c.recipientName}.\n\nO prazo do processo "${c.envelopeTitle}" terminou antes da conclusão de todas as assinaturas. Novas assinaturas foram bloqueadas.`,
      html: layout(
        brand,
        'Prazo de assinatura encerrado',
        p(`Olá, ${escapeHtml(c.recipientName)}.`) +
          p(`O prazo do processo <strong>${escapeHtml(c.envelopeTitle)}</strong> terminou antes da conclusão de todas as assinaturas. Novas assinaturas foram bloqueadas.`),
        c.link ? { label: 'Ver envelope', url: c.link } : undefined,
      ),
    };
  },

  signer_declined(brand: Branding, c: EnvelopeStatusCtx): RenderedEmail {
    return {
      subject: `Recusa de assinatura: ${c.envelopeTitle}`,
      text: `Olá, ${c.recipientName}.\n\n${c.signerName ?? 'Um signatário'} recusou a assinatura de "${c.envelopeTitle}".${c.reason ? `\nMotivo informado: ${c.reason}` : ''}`,
      html: layout(
        brand,
        'Assinatura recusada',
        p(`Olá, ${escapeHtml(c.recipientName)}.`) +
          p(`<strong>${escapeHtml(c.signerName ?? 'Um signatário')}</strong> recusou a assinatura de <strong>${escapeHtml(c.envelopeTitle)}</strong>.`) +
          (c.reason ? p(`Motivo informado: ${escapeHtml(c.reason)}`) : ''),
        c.link ? { label: 'Ver envelope', url: c.link } : undefined,
      ),
    };
  },

  user_verify_email(brand: Branding, c: UserLinkCtx): RenderedEmail {
    return {
      subject: `Confirme seu e-mail — ${brand.name}`,
      text: `Olá, ${c.name}.\n\nConfirme seu e-mail acessando: ${c.link}\n\nO link expira em 24 horas.`,
      html: layout(brand, 'Confirme seu e-mail', p(`Olá, ${escapeHtml(c.name)}.`) + p('Confirme seu endereço de e-mail para começar a enviar documentos. O link expira em 24 horas.'), {
        label: 'Confirmar e-mail',
        url: c.link,
      }),
    };
  },

  user_password_reset(brand: Branding, c: UserLinkCtx): RenderedEmail {
    return {
      subject: `Redefinição de senha — ${brand.name}`,
      text: `Olá, ${c.name}.\n\nPara redefinir sua senha acesse: ${c.link}\n\nO link expira em 1 hora. Se você não solicitou, ignore este e-mail.`,
      html: layout(
        brand,
        'Redefinição de senha',
        p(`Olá, ${escapeHtml(c.name)}.`) + p('Recebemos uma solicitação para redefinir sua senha. O link expira em 1 hora. Se você não solicitou, ignore este e-mail.'),
        { label: 'Redefinir senha', url: c.link },
      ),
    };
  },

  user_invitation(brand: Branding, c: UserLinkCtx): RenderedEmail {
    return {
      subject: `Convite para ${c.organizationName ?? brand.name}`,
      text: `Olá, ${c.name}.\n\nVocê foi adicionado(a) à organização ${c.organizationName ?? ''} em ${brand.name}.\nDefina sua senha: ${c.link}\n\nO link expira em 1 hora; depois disso use "Esqueci minha senha".`,
      html: layout(
        brand,
        'Você recebeu um convite',
        p(`Olá, ${escapeHtml(c.name)}.`) +
          p(`Você foi adicionado(a) à organização <strong>${escapeHtml(c.organizationName ?? '')}</strong>.`) +
          p('Defina sua senha para acessar. O link expira em 1 hora; depois disso use “Esqueci minha senha”.'),
        { label: 'Definir senha', url: c.link },
      ),
    };
  },
} as const;

export type EmailTemplateName =
  | 'signer_invite'
  | 'signer_reminder'
  | 'signer_otp'
  | 'envelope_completed_signer'
  | 'envelope_completed_owner'
  | 'envelope_cancelled_signer'
  | 'envelope_cancelled_owner'
  | 'envelope_expired_signer'
  | 'envelope_expired_owner'
  | 'signer_declined_owner'
  | 'user_verify_email'
  | 'user_password_reset'
  | 'user_invitation';
