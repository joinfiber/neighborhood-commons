/**
 * API Key Management — Neighborhood Commons
 *
 * Shared key generation and storage logic. Used by both admin routes
 * and developer self-registration. One function, one INSERT shape.
 *
 * Keys are nc_<32 hex chars>. The raw key is returned once to the
 * caller; only the SHA-256 hash is stored in the database.
 */

import { createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from './supabase.js';

export interface StoredKey {
  id: string;
  name: string;
  created_at: string;
}

export interface GeneratedKey extends StoredKey {
  raw_key: string;
}

/** Generate a prefixed API key: nc_<32 random hex chars> */
function generateRawKey(): string {
  return 'nc_' + randomBytes(16).toString('hex');
}

/** SHA-256 hash of a raw key for storage */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate a new API key, hash it, and store it in the database.
 * Returns the raw key (shown once) and row metadata.
 *
 * Throws on insert failure — caller handles the error.
 */
export async function generateAndStoreKey(
  name: string,
  contactEmail: string,
  tier: string = 'free',
  rateLimitPerHour: number = 1000,
): Promise<GeneratedKey> {
  const rawKey = generateRawKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.substring(0, 12);

  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .insert({
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name,
      contact_email: contactEmail,
      tier,
      rate_limit_per_hour: rateLimitPerHour,
    })
    .select('id, name, created_at')
    .single();

  if (error) {
    throw error;
  }

  return {
    id: data.id,
    name: data.name,
    created_at: data.created_at,
    raw_key: rawKey,
  };
}
