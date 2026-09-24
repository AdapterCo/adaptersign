import { randomNumericCode, randomToken, safeEqual } from '../../src/common/crypto/crypto.util';
import { maskCpf, maskEmail, maskIp, maskName, maskPhone } from '../../src/common/util/mask';
import { normalizeCpf, toWinAnsiSafe } from '../../src/common/util/text';
import { generateValidationCode, isValidationCodeFormat, normalizeValidationCode } from '../../src/common/util/validation-code';
import { signWebhook, verifyWebhook } from '../../src/modules/webhooks/webhook-signature';
import { isBlockedAddress } from '../../src/modules/webhooks/url-safety';

describe('tokens e códigos', () => {
  it('gera tokens opacos de alta entropia e únicos', () => {
    const a = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 200 }, () => randomToken())).size).toBe(200);
  });

  it('gera OTP numérico de 6 dígitos', () => {
    for (let i = 0; i < 50; i++) expect(randomNumericCode(6)).toMatch(/^\d{6}$/);
  });

  it('comparação segura', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('código público de validação', () => {
  it('formato ADP-XXXX-XXXX-XXXX sem caracteres ambíguos', () => {
    const code = generateValidationCode('ADP');
    expect(isValidationCodeFormat(code)).toBe(true);
    expect(code.slice(4)).not.toMatch(/[ILOU]/);
  });

  it('normaliza entrada do usuário', () => {
    expect(normalizeValidationCode(' adp-8f7k-29qm-x82p ')).toBe('ADP-8F7K-29QM-X82P');
    expect(normalizeValidationCode('ADP-8F7K-29QM-X8OP')).toBe('ADP-8F7K-29QM-X80P');
  });
});

describe('mascaramento (LGPD)', () => {
  it('mascara e-mail, CPF, telefone, IP e nome', () => {
    expect(maskEmail('daniel@email.com')).toBe('d****l@e****.com');
    expect(maskEmail('ab@x.io')).toBe('a*@x*.io');
    expect(maskCpf('00')).toBe('***.***.***-00');
    expect(maskPhone('+55 11 99999-1234')).toMatch(/1234$/);
    expect(maskIp('203.0.113.45')).toBe('203.0.*.*');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:****');
    expect(maskName('Maria da Silva')).toBe('Maria d. S.');
  });
});

describe('CPF', () => {
  it('valida dígitos verificadores', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
    expect(normalizeCpf('111.111.111-11')).toBeNull();
    expect(normalizeCpf('529.982.247-24')).toBeNull();
  });
});

describe('texto para PDF (WinAnsi)', () => {
  it('preserva acentos do português e substitui caracteres não suportados', () => {
    expect(toWinAnsiSafe('Ação São João')).toBe('Ação São João');
    expect(toWinAnsiSafe('→ 😀')).toBe('? ?');
  });
});

describe('webhooks HMAC', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt', type: 'envelope.completed' });

  it('assina e verifica', () => {
    const ts = 1_800_000_000;
    const sig = signWebhook(secret, ts, 'evt-1', body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhook(secret, { signature: sig, timestamp: String(ts), eventId: 'evt-1' }, body, ts + 10)).toBe(true);
  });

  it('rejeita replay fora da janela e adulteração', () => {
    const ts = 1_800_000_000;
    const sig = signWebhook(secret, ts, 'evt-1', body);
    expect(verifyWebhook(secret, { signature: sig, timestamp: String(ts), eventId: 'evt-1' }, body, ts + 3600)).toBe(false);
    expect(verifyWebhook(secret, { signature: sig, timestamp: String(ts), eventId: 'evt-2' }, body, ts)).toBe(false);
    expect(verifyWebhook(secret, { signature: sig, timestamp: String(ts), eventId: 'evt-1' }, body + ' ', ts)).toBe(false);
  });
});

describe('proteção SSRF de webhooks', () => {
  it('bloqueia endereços internos', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '100.64.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('permite endereços públicos', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });
});
