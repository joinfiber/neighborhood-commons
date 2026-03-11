/**
 * Supabase Clients — Neighborhood Commons
 *
 * Two clients:
 * 1. supabaseAdmin (service role) — all writes, internal operations
 * 2. createUserClient(token) — portal business auth (respects RLS)
 *
 * Commons RLS model:
 * - events: SELECT = true (public), writes = service_role only
 * - portal_accounts: own-account access via auth_user_id = auth.uid()
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

export const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

/**
 * Create a user-scoped Supabase client from a JWT token.
 * Used for portal business operations that go through RLS.
 */
export function createUserClient(token: string) {
  return createClient(config.supabase.url, config.supabase.anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}
