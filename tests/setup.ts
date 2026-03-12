/**
 * Test setup — set required env vars before any module loads config.
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.AUDIT_SALT = 'test-audit-salt-16chars';
process.env.CRON_SECRET = 'test-cron-secret-16chars';
process.env.COMMONS_SERVICE_KEY = 'test-service-key-that-is-at-least-32-chars-long';
process.env.COMMONS_ADMIN_USER_IDS = 'admin-uuid-1,admin-uuid-2';
process.env.API_BASE_URL = 'https://commons.test';
process.env.INTEGRATION_TEST = 'true';
