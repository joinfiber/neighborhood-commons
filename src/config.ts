/**
 * Commons API Configuration
 *
 * Centralized config for The Fiber Commons service.
 * All environment variables are validated at boot.
 */

import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.string().default('3001'),

  // Supabase (Commons instance — required)
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Security
  AUDIT_SALT: z.string().min(16),

  // IP Filtering
  IP_FILTER_ENABLED: z.enum(['true', 'false']).default('true'),

  // Cloudflare Turnstile CAPTCHA (portal registration)
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  CAPTCHA_ENABLED: z.enum(['true', 'false']).default('false'),

  // Commons Admin (comma-separated UIDs)
  COMMONS_ADMIN_USER_IDS: z.string().optional(),

  // Mailgun (portal account emails)
  MAILGUN_API_KEY: z.string().min(1).optional(),
  MAILGUN_DOMAIN: z.string().min(1).optional(),

  // Cloudflare R2 (fiber-commons-images bucket)
  COMMONS_R2_ACCOUNT_ID: z.string().min(1).optional(),
  COMMONS_R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  COMMONS_R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  COMMONS_R2_BUCKET_NAME: z.string().default('fiber-commons-images'),

  // Cron secret
  CRON_SECRET: z.string().min(16).optional(),

  // Internal sync auth (service-to-service)
  COMMONS_SERVICE_KEY: z.string().min(32).optional(),

  // Dual-write bridge (temporary — Phase 2 only)
  SOCIAL_SUPABASE_URL: z.string().url().optional(),
  SOCIAL_SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // CORS
  CORS_ORIGINS: z.string().default('https://commons.joinfiber.app,https://post.joinfiber.app'),

  // API base URL
  API_BASE_URL: z.string().url().optional(),

  // Webhook encryption key (optional — for encrypted signing secrets)
  WEBHOOK_ENCRYPTION_KEY: z.string().min(32).optional(),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(parsed.error.format());
    process.exit(1);
  }

  return parsed.data;
}

const env = loadConfig();

function parseList(value: string | undefined): string[] {
  const cleaned = (value || '').replace(/^["']|["']$/g, '');
  return cleaned.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: parseInt(env.PORT, 10),

  supabase: {
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  },

  security: {
    auditSalt: env.AUDIT_SALT,
    ipFilterEnabled: env.IP_FILTER_ENABLED === 'true',
  },

  captcha: {
    enabled: env.CAPTCHA_ENABLED === 'true',
    secretKey: env.TURNSTILE_SECRET_KEY || '',
  },

  admin: {
    userIds: parseList(env.COMMONS_ADMIN_USER_IDS),
  },

  mailgun: {
    apiKey: env.MAILGUN_API_KEY || '',
    domain: env.MAILGUN_DOMAIN || '',
    from: env.MAILGUN_DOMAIN ? `Fiber Commons <noreply@${env.MAILGUN_DOMAIN}>` : '',
  },

  r2: {
    accountId: env.COMMONS_R2_ACCOUNT_ID || '',
    accessKeyId: env.COMMONS_R2_ACCESS_KEY_ID || '',
    secretAccessKey: env.COMMONS_R2_SECRET_ACCESS_KEY || '',
    bucketName: env.COMMONS_R2_BUCKET_NAME,
    enabled: !!(env.COMMONS_R2_ACCOUNT_ID && env.COMMONS_R2_ACCESS_KEY_ID),
  },

  cors: {
    origins: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
  },

  cron: {
    secret: env.CRON_SECRET || '',
  },

  internal: {
    serviceKey: env.COMMONS_SERVICE_KEY || '',
  },

  // Dual-write bridge (temporary — removed after Phase 3)
  socialSupabase: env.SOCIAL_SUPABASE_URL ? {
    url: env.SOCIAL_SUPABASE_URL,
    serviceRoleKey: env.SOCIAL_SUPABASE_SERVICE_ROLE_KEY || '',
  } : null,

  apiBaseUrl: env.API_BASE_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),

  rateLimit: {
    windowMs: 60 * 1000,
    max: 120,
  },

  webhooks: {
    deliveryTimeoutMs: 10_000,
    maxRetries: 3,
    maxConsecutiveFailures: 10,
    retentionDays: 30,
    maxSubscriptions: { free: 5, pro: 25, partner: 100 } as Record<string, number>,
    encryptionKey: env.WEBHOOK_ENCRYPTION_KEY || '',
  },

  apiKeys: {
    rateLimitsPerHour: { free: 1000, pro: 5000, partner: 20000 } as Record<string, number>,
  },
} as const;
