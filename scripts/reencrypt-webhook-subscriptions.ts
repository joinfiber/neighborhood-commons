/**
 * One-shot recovery: re-encrypt existing webhook subscription signing secrets.
 *
 * Before the fix in PR #8, `POST /api/v1/webhooks` inserted the encrypted
 * signing secret into the `bytea` column by passing a Node Buffer directly
 * through Supabase JS's RPC path. supabase-js serialized the Buffer as
 * `{"type":"Buffer","data":[...]}` JSON, which got stored as bytea bytes —
 * garbage that fails AES-GCM authentication on every delivery attempt.
 * Delivery rows silently accumulated in `pending` state for weeks.
 *
 * This script reads the plaintext `signing_secret` column (still valid —
 * the original encryption didn't destroy it) and rewrites the
 * `signing_secret_encrypted` column using the now-correct `\x<hex>`
 * bytea encoding.
 *
 * How to run (against Railway production):
 *
 *   railway run -s neighborhood-commons -- npx tsx scripts/reencrypt-webhook-subscriptions.ts
 *
 * Or locally with prod env vars:
 *
 *   WEBHOOK_ENCRYPTION_KEY=<64-hex> \
 *   SUPABASE_URL=<...> \
 *   SUPABASE_SERVICE_ROLE_KEY=<...> \
 *   AUDIT_SALT=<...> \
 *   npx tsx scripts/reencrypt-webhook-subscriptions.ts
 *
 * Safe to run multiple times — re-encryption is idempotent and produces
 * identical ciphertext bytes only by coincidence (new IV each run), but
 * decryption works regardless of which run's ciphertext is current.
 *
 * What it does NOT touch:
 *   - The plaintext `signing_secret` column (left intact as belt-and-braces
 *     recovery; subscribers' cached secrets stay valid)
 *   - Pending/failed delivery rows (operator can requeue manually if desired)
 *   - Subscription status
 */

import { createClient } from '@supabase/supabase-js';
import { encryptSecret, isEncryptionConfigured, bufferToBytea } from '../src/lib/webhook-crypto.js';

async function main(): Promise<void> {
  if (!isEncryptionConfigured()) {
    console.error('WEBHOOK_ENCRYPTION_KEY is not set — nothing to do. Set it and re-run.');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  console.log('[REENCRYPT] Fetching webhook subscriptions with a plaintext secret...');
  const { data: subs, error: fetchErr } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, signing_secret, status')
    .not('signing_secret', 'is', null);

  if (fetchErr) {
    console.error('[REENCRYPT] Fetch error:', fetchErr.message);
    process.exit(1);
  }
  if (!subs || subs.length === 0) {
    console.log('[REENCRYPT] No subscriptions found with a plaintext secret. Nothing to do.');
    return;
  }

  console.log(`[REENCRYPT] Found ${subs.length} subscription(s). Re-encrypting each...`);

  let successes = 0;
  let failures = 0;
  for (const sub of subs) {
    const plaintext = (sub as { signing_secret?: string | null }).signing_secret;
    if (!plaintext) {
      console.warn(`[REENCRYPT] ${sub.id} ${sub.url}: plaintext column is empty; skipping.`);
      continue;
    }

    try {
      const encoded = bufferToBytea(encryptSecret(plaintext));
      const { error: updateErr } = await supabase
        .from('webhook_subscriptions')
        .update({ signing_secret_encrypted: encoded })
        .eq('id', sub.id);

      if (updateErr) {
        console.error(`[REENCRYPT] ${sub.id} ${sub.url}: update failed —`, updateErr.message);
        failures++;
        continue;
      }

      console.log(`[REENCRYPT] ${sub.id} ${sub.url} (${sub.status}): re-encrypted OK.`);
      successes++;
    } catch (err) {
      console.error(`[REENCRYPT] ${sub.id} ${sub.url}: exception —`, err instanceof Error ? err.message : err);
      failures++;
    }
  }

  console.log('');
  console.log(`[REENCRYPT] Done. ${successes} succeeded, ${failures} failed.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[REENCRYPT] Unhandled error:', err);
  process.exit(1);
});
