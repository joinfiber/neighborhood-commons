/**
 * Commons API Configuration
 *
 * Centralized config for Neighborhood Commons.
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

  // SSRF hardening — when '1', outbound fetches to user-supplied URLs use
  // a dispatcher that re-resolves the hostname at connect time and rejects
  // any resolution landing on a private/reserved IP. Defeats DNS rebinding.
  // Kept behind a flag for staged rollout: the first deploy after landing
  // this code runs with it off so any connect-hook bug surfaces as no regression.
  SSRF_STRICT: z.enum(['0', '1']).default('0'),

  // Cloudflare Turnstile CAPTCHA (portal registration)
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  CAPTCHA_ENABLED: z.enum(['true', 'false']).default('false'),

  // Commons Admin (comma-separated UIDs)
  COMMONS_ADMIN_USER_IDS: z.string().optional(),

  // Email (transactional emails via Resend)
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_DOMAIN: z.string().min(1).optional(),

  // Cloudflare R2 (neighborhood-commons-images bucket)
  COMMONS_R2_ACCOUNT_ID: z.string().min(1).optional(),
  COMMONS_R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  COMMONS_R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  COMMONS_R2_BUCKET_NAME: z.string().default('neighborhood-commons-images'),
  R2_PUBLIC_URL: z.string().url().optional(),

  // Cron secret
  CRON_SECRET: z.string().min(16).optional(),

  // CORS
  CORS_ORIGINS: z.string().default('https://neighborhood-commons.org,https://api.neighborhood-commons.org,https://merrie.co'),

  // API base URL
  API_BASE_URL: z.string().url().optional(),

  // Webhook encryption key — required in production. Without it, signing
  // secrets would be stored as plaintext and the system would quietly
  // degrade. config.ts refuses to boot in production if missing (see below).
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  WEBHOOK_ENCRYPTION_KEY: z.string().length(64).regex(/^[0-9a-fA-F]+$/).optional(),

  // NODE_ENV — controls production-gated invariants (e.g. WEBHOOK_ENCRYPTION_KEY).
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Google Places API (venue search in portal)
  GOOGLE_PLACES_API_KEY: z.string().min(1).optional(),

  // Default region for new portal events (UUID from regions table)
  DEFAULT_REGION_ID: z.string().uuid().optional(),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(parsed.error.format());
    process.exit(1);
  }

  // Production invariants — refuse to boot rather than degrade silently.
  // WEBHOOK_ENCRYPTION_KEY: if absent, webhook signing secrets fall back to
  // plaintext at rest (see webhook-crypto.ts::isEncryptionConfigured). That
  // degradation is acceptable for local dev but not production.
  if (parsed.data.NODE_ENV === 'production') {
    if (!parsed.data.WEBHOOK_ENCRYPTION_KEY) {
      console.error('FATAL: WEBHOOK_ENCRYPTION_KEY is required in production.');
      console.error('Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      process.exit(1);
    }
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
    ssrfStrict: env.SSRF_STRICT === '1',
  },

  captcha: {
    enabled: env.CAPTCHA_ENABLED === 'true',
    secretKey: env.TURNSTILE_SECRET_KEY || '',
  },

  admin: {
    userIds: parseList(env.COMMONS_ADMIN_USER_IDS),
  },

  email: {
    apiKey: env.RESEND_API_KEY || '',
    domain: env.RESEND_FROM_DOMAIN || '',
    from: env.RESEND_FROM_DOMAIN ? `Neighborhood Commons <noreply@${env.RESEND_FROM_DOMAIN}>` : '',
  },

  r2: {
    accountId: env.COMMONS_R2_ACCOUNT_ID || '',
    accessKeyId: env.COMMONS_R2_ACCESS_KEY_ID || '',
    secretAccessKey: env.COMMONS_R2_SECRET_ACCESS_KEY || '',
    bucketName: env.COMMONS_R2_BUCKET_NAME,
    enabled: !!(env.COMMONS_R2_ACCOUNT_ID && env.COMMONS_R2_ACCESS_KEY_ID && env.COMMONS_R2_SECRET_ACCESS_KEY),
    publicUrl: env.R2_PUBLIC_URL || '',
  },

  cors: {
    origins: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
  },

  cron: {
    secret: env.CRON_SECRET || '',
  },

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
    maxSubscriptionsPerKey: 5,
    encryptionKey: env.WEBHOOK_ENCRYPTION_KEY || '',
  },

  apiKeys: {
    rateLimitPerHour: 1000,
  },

  google: {
    placesApiKey: env.GOOGLE_PLACES_API_KEY || '',
  },

  defaultRegionId: env.DEFAULT_REGION_ID || null,
} as const;
