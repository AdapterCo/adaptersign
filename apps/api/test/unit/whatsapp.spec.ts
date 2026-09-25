import { AuthMethod } from '../../src/generated/prisma/client';
import { maskPhone, normalizePhone } from '../../src/common/util/phone';
import { defaultOtpChannel, otpChannels, sessionSatisfies } from '../../src/modules/signing/auth-methods';
import { EvolutionWhatsAppProvider, WhatsAppSendError } from '../../src/infra/whatsapp/whatsapp.provider';
import { WhatsAppTemplates } from '../../src/modules/notifications/templates';
import type { Branding } from '../../src/config/branding';

describe('normalizePhone', () => {
  it.each([
    ['(24) 99999-1234', '+5524999991234'],
    ['024 99999-1234', '+5524999991234'],
    ['24 3333-1234', '+552433331234'],
    ['+55 24 99999-1234', '+5524999991234'],
    ['5524999991234', '+5524999991234'],
    ['0055 24 99999-1234', '+5524999991234'],
    ['+1 415 555 0100', '+14155550100'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(['123', '99999-1234', '+55 24 999', 'abc'])('recusa %s', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });

  it('mascara para exibição', () => {
    expect(maskPhone('+5524999991234')).toBe('+55 24 •••••-1234');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('canais do código (OTP)', () => {
  const withPhone = { authMethod: AuthMethod.EMAIL_OTP, phone: '+5524999991234' };

  it('e-mail sempre; WhatsApp só com telefone e canal ativo', () => {
    expect(otpChannels(withPhone, true)).toEqual(['EMAIL', 'WHATSAPP']);
    expect(otpChannels(withPhone, false)).toEqual(['EMAIL']);
    expect(otpChannels({ ...withPhone, phone: null }, true)).toEqual(['EMAIL']);
    expect(otpChannels({ ...withPhone, authMethod: AuthMethod.WHATSAPP_OTP }, true)).toEqual(['WHATSAPP']);
    expect(otpChannels({ ...withPhone, authMethod: AuthMethod.WHATSAPP_OTP }, false)).toEqual([]);
  });

  it('segue o canal do link (links da API → WhatsApp quando possível)', () => {
    expect(defaultOtpChannel(['EMAIL', 'WHATSAPP'], 'WHATSAPP')).toBe('WHATSAPP');
    expect(defaultOtpChannel(['EMAIL', 'WHATSAPP'], 'API')).toBe('WHATSAPP');
    expect(defaultOtpChannel(['EMAIL', 'WHATSAPP'], 'EMAIL')).toBe('EMAIL');
    expect(defaultOtpChannel(['EMAIL'], 'WHATSAPP')).toBe('EMAIL');
    expect(defaultOtpChannel([], 'EMAIL')).toBeNull();
  });

  it('sessão autenticada por WhatsApp atende "código de verificação"; o inverso não', () => {
    expect(sessionSatisfies(AuthMethod.EMAIL_OTP, AuthMethod.WHATSAPP_OTP)).toBe(true);
    expect(sessionSatisfies(AuthMethod.EMAIL_OTP, AuthMethod.EMAIL_OTP)).toBe(true);
    expect(sessionSatisfies(AuthMethod.WHATSAPP_OTP, AuthMethod.EMAIL_OTP)).toBe(false);
    expect(sessionSatisfies(AuthMethod.EMAIL_OTP, null)).toBe(false);
  });
});

describe('EvolutionWhatsAppProvider', () => {
  function fakeFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('envia texto para a instância com a apikey e devolve o id da mensagem', async () => {
    const { fn, calls } = fakeFetch(201, { key: { id: 'MSG123' } });
    const p = new EvolutionWhatsAppProvider('https://evo.exemplo.test/', 'chave-secreta', 'central', 5000, fn);
    await expect(p.sendText('+5524999991234', 'Olá')).resolves.toEqual({ messageId: 'MSG123' });
    expect(calls[0].url).toBe('https://evo.exemplo.test/message/sendText/central');
    expect((calls[0].init.headers as Record<string, string>).apikey).toBe('chave-secreta');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ number: '5524999991234', text: 'Olá' });
  });

  it('número inexistente (400) é erro definitivo; 5xx permite nova tentativa', async () => {
    const bad = new EvolutionWhatsAppProvider('https://evo.exemplo.test', 'k'.repeat(8), 'central', 5000, fakeFetch(400, { exists: false }).fn);
    await expect(bad.sendText('+5524999991234', 'x')).rejects.toMatchObject({ permanent: true });
    const down = new EvolutionWhatsAppProvider('https://evo.exemplo.test', 'k'.repeat(8), 'central', 5000, fakeFetch(502, 'bad gateway').fn);
    const err = await down.sendText('+5524999991234', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect((err as WhatsAppSendError).permanent).toBe(false);
  });
});

describe('WhatsAppTemplates', () => {
  const brand: Branding = { name: 'Adapter Sign', primaryColor: '#1F4FD1', appUrl: 'https://app.exemplo.test', validationCodePrefix: 'ADP' };

  it('convite identifica a empresa e traz o link; código não traz link', () => {
    const invite = WhatsAppTemplates.signer_invite(brand, {
      signerName: 'Maria',
      senderOrg: 'Loja Fictícia',
      envelopeTitle: 'Contrato 123',
      message: null,
      link: 'https://app.exemplo.test/sign/abc',
      expiresAt: null,
      reminder: false,
    });
    expect(invite).toContain('Loja Fictícia');
    expect(invite).toContain('https://app.exemplo.test/sign/abc');
    const otp = WhatsAppTemplates.signer_otp(brand, { signerName: 'Maria', code: '123456', minutes: 10, envelopeTitle: 'Contrato 123' });
    expect(otp).toContain('*123456*');
    expect(otp).not.toContain('http');
  });
});
