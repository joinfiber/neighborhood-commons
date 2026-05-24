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

  // SSRF hardening — outbound fetches to user-supplied URLs route through a
  // dispatcher that re-resolves the hostname at connect time and rejects any
  // resolution landing on a private/reserved IP. Closes the DNS-rebinding
  // TOCTOU between the upfront validate*Url check and the actual TCP connect.
  // On by default; '0' is an escape hatch only if a connect-hook incident is
  // ever traced here. Production must never run with '0' (asserted at boot).
  SSRF_STRICT: z.enum(['0', '1']).default('1'),

  // Cloudflare Turnstile CAPTCHA (portal registration). Use a dedicated widget
  // for the Commons (its own site+secret, scoped to the Commons domain): the
  // site key is public (rendered in the form), the secret verifies tokens.
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
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

  // Operator notification + operator-portal access. Comma-separated list of
  // emails — the first entry receives report/dispute alerts (existing
  // behaviour); every entry on the list is granted access to /operator/*
  // when logged in to the developer portal with that email. Single-email
  // values are accepted unchanged.
  COMMONS_OPERATOR_EMAIL: z.string().optional().refine(
    (val) => {
      if (!val) return true;
      const parts = val.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) return false;
      return parts.every((p) => z.string().email().safeParse(p).success);
    },
    { message: 'Must be one email or a comma-separated list of valid emails.' },
  ),

  // DMCA designated agent — surfaced at /dmca (HTML) and /api/v1/dmca (JSON).
  // When the agent fields are unset, the endpoint reports status=pending_registration
  // and points users at the operator email for interim takedown contact.
  // Once registered with the U.S. Copyright Office, populate these fields
  // from the registration record. The agent can be an individual or entity.
  COMMONS_DMCA_AGENT_NAME: z.string().min(1).optional(),
  COMMONS_DMCA_AGENT_EMAIL: z.string().email().optional(),
  COMMONS_DMCA_AGENT_PHONE: z.string().min(1).optional(),
  COMMONS_DMCA_AGENT_ADDRESS: z.string().min(1).optional(),
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
    // SSRF_STRICT defaults to '1'; refuse an explicit downgrade in production —
    // running with '0' re-opens the DNS-rebinding TOCTOU on every outbound fetch
    // to a user-supplied URL (webhooks, image-by-URL, feed import).
    if (parsed.data.SSRF_STRICT !== '1') {
      console.error("FATAL: SSRF_STRICT must be '1' in production (DNS-rebinding defense).");
      process.exit(1);
    }
    // CRON_SECRET authenticates every /api/cron route (timing-safe compare). If
    // it's unset in production the middleware fail-closes — cron silently stops
    // (webhook retries, image verify, series extend never run). Refuse to boot.
    if (!parsed.data.CRON_SECRET) {
      console.error('FATAL: CRON_SECRET is required in production (cron route auth).');
      process.exit(1);
    }
    // If CAPTCHA is enabled in production it must be fully configured — a missing
    // site or secret key would silently disable bot protection on registration.
    if (parsed.data.CAPTCHA_ENABLED === 'true' && (!parsed.data.TURNSTILE_SECRET_KEY || !parsed.data.TURNSTILE_SITE_KEY)) {
      console.error('FATAL: CAPTCHA_ENABLED=true requires TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY.');
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
    siteKey: env.TURNSTILE_SITE_KEY || '',
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

  operator: {
    // Legacy field — kept as the bare-string the notify code reads.
    // When multiple emails are configured, this is the first one.
    email: parseList(env.COMMONS_OPERATOR_EMAIL)[0] || '',
    // Full list. Empty when COMMONS_OPERATOR_EMAIL is unset. Used by the
    // operator-portal middleware to gate /operator/* access.
    emails: parseList(env.COMMONS_OPERATOR_EMAIL).map((e) => e.toLowerCase()),
  },

  // DMCA designated agent. `registered` is true when all fields are populated;
  // false (with status='pending_registration' on the public endpoint) otherwise.
  dmca: {
    agentName: env.COMMONS_DMCA_AGENT_NAME || '',
    agentEmail: env.COMMONS_DMCA_AGENT_EMAIL || '',
    agentPhone: env.COMMONS_DMCA_AGENT_PHONE || '',
    agentAddress: env.COMMONS_DMCA_AGENT_ADDRESS || '',
    registered: !!(
      env.COMMONS_DMCA_AGENT_NAME
      && env.COMMONS_DMCA_AGENT_EMAIL
      && env.COMMONS_DMCA_AGENT_PHONE
      && env.COMMONS_DMCA_AGENT_ADDRESS
    ),
  },
} as const;
