/**
 * Image URL Verification — Neighborhood Commons
 *
 * Checks that event and organization image URLs are reachable.
 * Flags broken URLs so they can be cleared or re-uploaded.
 * Called by the verify-images cron job.
 *
 * v2 (migration 082): profile images moved from portal_accounts to
 * organizations. verifyAccountImages now scans organizations.logo_url
 * and organizations.image_url.
 */

import { supabaseAdmin } from './supabase.js';
import { validateFeedUrl } from './url-validation.js';
import { safeFetch } from './safe-fetch.js';

const BATCH_SIZE = 100;
const TIMEOUT_MS = 5000;

interface VerifyResult {
  checked: number;
  broken: number;
  cleared: number;
  broken_urls: Array<{ id: string; url: string; status: number | null }>;
}

/**
 * Check all event image URLs are reachable. Clears broken ones.
 */
export async function verifyEventImages(): Promise<VerifyResult> {
  const { data: events } = await supabaseAdmin
    .from('events')
    .select('id, event_image_url')
    .not('event_image_url', 'is', null)
    .limit(BATCH_SIZE);

  if (!events || events.length === 0) {
    return { checked: 0, broken: 0, cleared: 0, broken_urls: [] };
  }

  let broken = 0;
  let cleared = 0;
  const broken_urls: VerifyResult['broken_urls'] = [];

  for (const event of events) {
    const url = event.event_image_url as string;
    if (!url) continue;

    // SSRF protection: validate URL resolves to a public IP before probing
    try { await validateFeedUrl(url); } catch {
      console.log(`[IMAGES] Skipping SSRF-blocked URL for event ${event.id}: ${url}`);
      continue;
    }

    try {
      const response = await safeFetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'NeighborhoodCommons/1.0 (image-verify)' },
      });

      if (!response.ok) {
        broken++;
        broken_urls.push({ id: event.id, url, status: response.status });

        // Clear the broken URL so consumers don't get 404 images
        if (response.status === 404 || response.status === 410) {
          await supabaseAdmin
            .from('events')
            .update({ event_image_url: null })
            .eq('id', event.id);
          cleared++;
          console.log(`[IMAGES] Cleared broken image for event ${event.id}: ${response.status}`);
        }
      }
    } catch (err) {
      // Network error or timeout — log but don't clear (may be transient)
      broken++;
      broken_urls.push({ id: event.id, url, status: null });
      console.log(`[IMAGES] Unreachable image for event ${event.id}: ${err instanceof Error ? err.message : 'timeout'}`);
    }
  }

  return { checked: events.length, broken, cleared, broken_urls };
}

/**
 * Check all organization image URLs (logo + hero image) are reachable.
 */
export async function verifyAccountImages(): Promise<VerifyResult> {
  const { data: orgs } = await supabaseAdmin
    .from('organizations')
    .select('id, logo_url, image_url')
    .or('logo_url.not.is.null,image_url.not.is.null')
    .limit(BATCH_SIZE);

  if (!orgs || orgs.length === 0) {
    return { checked: 0, broken: 0, cleared: 0, broken_urls: [] };
  }

  let checked = 0;
  let broken = 0;
  let cleared = 0;
  const broken_urls: VerifyResult['broken_urls'] = [];

  for (const org of orgs) {
    for (const field of ['logo_url', 'image_url'] as const) {
      const url = org[field] as string | null;
      if (!url) continue;
      checked++;

      // SSRF protection: validate URL resolves to a public IP before probing
      try { await validateFeedUrl(url); } catch {
        console.log(`[IMAGES] Skipping SSRF-blocked ${field} for org ${org.id}: ${url}`);
        continue;
      }

      try {
        const response = await safeFetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'User-Agent': 'NeighborhoodCommons/1.0 (image-verify)' },
        });

        if (!response.ok) {
          broken++;
          broken_urls.push({ id: `${org.id}/${field}`, url, status: response.status });

          if (response.status === 404 || response.status === 410) {
            await supabaseAdmin
              .from('organizations')
              .update({ [field]: null })
              .eq('id', org.id);
            cleared++;
            console.log(`[IMAGES] Cleared broken ${field} for org ${org.id}: ${response.status}`);
          }
        }
      } catch (err) {
        broken++;
        broken_urls.push({ id: `${org.id}/${field}`, url, status: null });
      }
    }
  }

  return { checked, broken, cleared, broken_urls };
}
