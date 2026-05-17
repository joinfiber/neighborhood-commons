/**
 * Scrub R2 image objects for events under unclaimed portal_accounts.
 *
 * Migration 077 nulled `event_image_url` in the DB for these events, but the
 * underlying R2 object at `portal-events/{event_id}/image` still exists and
 * is served by `images.neighborhood-commons.org`. This script deletes those
 * objects so the bytes are gone, not just unreferenced.
 *
 * Targets every event whose `creator_account_id` points to a `portal_accounts`
 * row with `auth_user_id IS NULL`. Most of those events never had an image —
 * DELETE returns 404, which `deleteFromR2` treats as success. The ~57 events
 * that did have images get their R2 objects removed.
 *
 * How to run (against Railway production):
 *
 *   # Dry run first — counts the targets, touches nothing
 *   railway run -s neighborhood-commons -- npx tsx scripts/scrub-unclaimed-creator-photos.ts --dry-run
 *
 *   # Live run — prompts before deleting
 *   railway run -s neighborhood-commons -- npx tsx scripts/scrub-unclaimed-creator-photos.ts
 *
 * Required env (same as the Commons API):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, AUDIT_SALT,
 *   COMMONS_R2_ACCOUNT_ID, COMMONS_R2_ACCESS_KEY_ID, COMMONS_R2_SECRET_ACCESS_KEY
 *
 * Idempotent — safe to re-run.
 */

import { createClient } from '@supabase/supabase-js';
import * as readline from 'node:readline/promises';
import { deleteFromR2 } from '../src/lib/cloudflare.js';

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${prompt} (yes/no) `);
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[SCRUB] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }

  console.log('===================================================================');
  console.log(`[SCRUB] Mode:      ${dryRun ? 'DRY RUN (no R2 deletes)' : 'LIVE (will delete R2 objects)'}`);
  console.log(`[SCRUB] Target DB: ${supabaseUrl}`);
  console.log('===================================================================');

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // 1. Identify unclaimed portal_accounts.
  // v2 (migration 082): business_name moved to organizations. We only need
  // the account id for this scrub, so the narrower SELECT works post-082.
  const { data: accounts, error: acctErr } = await supabase
    .from('portal_accounts')
    .select('id')
    .is('auth_user_id', null);

  if (acctErr || !accounts) {
    console.error('[SCRUB] Failed to fetch portal_accounts:', acctErr?.message);
    process.exit(1);
  }

  console.log(`[SCRUB] Found ${accounts.length} unclaimed portal accounts.`);

  if (accounts.length === 0) {
    console.log('[SCRUB] Nothing to do.');
    return;
  }

  // 2. Pull every event under those accounts.
  const accountIds = accounts.map((a) => a.id);
  const { data: events, error: eventsErr } = await supabase
    .from('events')
    .select('id')
    .in('creator_account_id', accountIds);

  if (eventsErr || !events) {
    console.error('[SCRUB] Failed to fetch events:', eventsErr?.message);
    process.exit(1);
  }

  console.log(`[SCRUB] Found ${events.length} events under unclaimed creators.`);
  console.log('[SCRUB] Each event gets a DELETE for portal-events/{id}/image.');
  console.log('[SCRUB] Most are expected to 404 (never had an image); ~57 actual deletes expected.');

  if (dryRun) {
    console.log('[SCRUB] DRY RUN — exiting without touching R2.');
    return;
  }

  // 3. Confirm before destructive action.
  const ok = await confirm(`\n[SCRUB] Proceed with R2 DELETE for ${events.length} object keys?`);
  if (!ok) {
    console.log('[SCRUB] Aborted by user.');
    return;
  }

  // 4. Delete R2 objects.
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  for (const event of events) {
    const r2Key = `portal-events/${event.id}/image`;
    attempted++;
    const result = await deleteFromR2(r2Key);
    if (result.success) {
      succeeded++;
    } else {
      failed++;
      console.error(`[SCRUB] FAIL ${r2Key}: ${result.error}`);
    }
    if (attempted % 50 === 0) {
      console.log(`[SCRUB] Progress: ${attempted}/${events.length} attempted, ${failed} failures so far.`);
    }
  }

  console.log('');
  console.log('===================================================================');
  console.log('[SCRUB] Done.');
  console.log(`[SCRUB] Attempted:               ${attempted}`);
  console.log(`[SCRUB] Succeeded (200 or 404):  ${succeeded}`);
  console.log(`[SCRUB] Failed:                  ${failed}`);
  console.log('===================================================================');
  console.log('');
  console.log('Note: deleteFromR2 returns success on both 200 and 404, so the');
  console.log('counts above do not distinguish "actually deleted" from "wasn\'t there."');
  console.log('To verify actual byte deletion, spot-check a few of the 57 IDs via:');
  console.log('  curl -I https://images.neighborhood-commons.org/portal-events/{id}/image');
  console.log('  (should return 404 after this script runs)');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[SCRUB] Unhandled error:', err);
  process.exit(1);
});
