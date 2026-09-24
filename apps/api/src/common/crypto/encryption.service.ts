import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { hmacSha256Hex } from './crypto.util';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Cifra simétrica AES-256-GCM (Node/OpenSSL) para dados pessoais e segredos
 * que precisam ser recuperados (CPF, segredo HMAC de webhooks).
 * Formato: "v1:" + base64(iv | tag | ciphertext).
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;
  private readonly tokenSecret: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(config.ENCRYPTION_KEY, 'base64');
    this.tokenSecret = config.TOKEN_HASH_SECRET;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [version, data] = payload.split(':', 2);
    if (version !== VERSION || !data) throw new Error('Formato de dado cifrado desconhecido');
    const raw = Buffer.from(data, 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** Hash com pepper para tokens/OTP/API keys (apenas o hash é persistido). */
  hashToken(token: string, context = ''): string {
    return hmacSha256Hex(this.tokenSecret, `${context}:${token}`);
  }
}
