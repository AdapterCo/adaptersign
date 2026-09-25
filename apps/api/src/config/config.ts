import { z } from 'zod';

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1'));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    APP_PUBLIC_URL: z.url(),
    API_PUBLIC_URL: z.url(),
    CORS_ORIGINS: csv,
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    SWAGGER_ENABLED: bool(true),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    JWT_ACCESS_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: bool(true),

    // 32 bytes em base64 — cifra CPF e segredos de webhook (AES-256-GCM).
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY deve ter 32 bytes em base64'),
    // Pepper HMAC para hashes de tokens, OTPs e API keys.
    TOKEN_HASH_SECRET: z.string().min(32),

    // Vazio = endpoint padrão do Amazon S3 para a região.
    STORAGE_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
    STORAGE_REGION: z.string().default('auto'),
    STORAGE_BUCKET: z.string().min(1),
    STORAGE_ACCESS_KEY_ID: z.string().min(1),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
    STORAGE_FORCE_PATH_STYLE: bool(false),

    UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
    SIGNATURE_IMAGE_MAX_BYTES: z.coerce.number().int().positive().default(300 * 1024),

    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: bool(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().min(3),

    // WhatsApp (número central da plataforma). "none" = desabilitado (convites/códigos só por e-mail).
    WHATSAPP_PROVIDER: z.enum(['none', 'evolution']).default('none'),
    EVOLUTION_API_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
    EVOLUTION_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
    EVOLUTION_INSTANCE: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
    WHATSAPP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    // DDI usado quando o telefone é informado sem código do país (ex.: "24 99999-9999").
    PHONE_DEFAULT_COUNTRY_CODE: z.string().regex(/^[1-9][0-9]{0,2}$/).default('55'),

    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
    SIGNER_LINK_TTL_DAYS: z.coerce.number().int().positive().default(30),
    SIGNATURE_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
    REMINDER_MAX_COUNT: z.coerce.number().int().min(0).default(3),

    DEFAULT_PLAN_CODE: z.string().default('FREE'),
    REPORT_TIMEZONE: z.string().default('America/Sao_Paulo'),
    WEBHOOK_ALLOW_PRIVATE_TARGETS: bool(false),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

    // Feature flags: habilitar uma flag NÃO habilita um método sem integração real.
    FEATURE_SMS_AUTH: bool(false),
    FEATURE_WHATSAPP_AUTH: bool(false),
    FEATURE_ICP_BRASIL: bool(false),
    FEATURE_BIOMETRICS: bool(false),
    FEATURE_WHITE_LABEL: bool(false),

    BRAND_NAME: z.string().default('Adapter Sign'),
    BRAND_PRIMARY_COLOR: z.string().default('#1F4FD1'),
    BRAND_SUPPORT_EMAIL: z.string().optional(),
    VALIDATION_CODE_PREFIX: z
      .string()
      .regex(/^[A-Z]{2,5}$/)
      .default('ADP'),
  })
  .superRefine((env, ctx) => {
    if (env.WHATSAPP_PROVIDER === 'evolution') {
      for (const key of ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} é obrigatório com WHATSAPP_PROVIDER=evolution` });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE deve ser true em produção' });
      }
      if (env.WEBHOOK_ALLOW_PRIVATE_TARGETS) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_ALLOW_PRIVATE_TARGETS'],
          message: 'Destinos privados de webhook não são permitidos em produção',
        });
      }
      // Recusa valores de exemplo do .env.example em produção.
      const placeholders: Array<[keyof typeof env, boolean]> = [
        ['ENCRYPTION_KEY', Buffer.from(env.ENCRYPTION_KEY, 'base64').every((b) => b === 0)],
        ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET.startsWith('substitua')],
        ['TOKEN_HASH_SECRET', env.TOKEN_HASH_SECRET.startsWith('substitua')],
      ];
      for (const [key, isPlaceholder] of placeholders) {
        if (isPlaceholder) ctx.addIssue({ code: 'custom', path: [key], message: 'Valor de exemplo não pode ser usado em produção' });
      }
      if (!env.APP_PUBLIC_URL.startsWith('https://') || !env.API_PUBLIC_URL.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['APP_PUBLIC_URL'], message: 'URLs públicas devem usar HTTPS em produção' });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

let cached: AppConfig | undefined;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Mostra apenas nomes das variáveis e mensagens, nunca os valores.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
