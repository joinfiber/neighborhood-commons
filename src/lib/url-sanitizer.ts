/**
 * URL Sanitizer
 *
 * Strips tracking parameters from URLs and observes domain allowlist hits.
 *
 *  - sanitizeUrl(url): strip tracking params. Used everywhere.
 *  - checkApprovedDomain(url): log-only domain check. Used by portal /
 *    admin paths where we don't want to reject — only observe.
 */

import { supabaseAdmin } from './supabase.js';

/** Tracking parameters to strip from URLs */
const TRACKING_PARAMS = new Set([
  // Google / GA
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_source_platform', '_ga', '_gl', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  // Facebook / Meta
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
  // Instagram
  'igshid', 'ig_mid',
  // Microsoft / Bing
  'msclkid',
  // Mailchimp
  'mc_cid', 'mc_eid',
  // TikTok
  'ttclid', '_ttp',
  // Twitter / X
  'twclid',
  // Misc social / analytics
  'si', 'mibextid', 's', 'ref', 'ref_src', 'ref_url',
  // HubSpot
  'hsa_cam', 'hsa_grp', 'hsa_mt', 'hsa_src', 'hsa_ad', 'hsa_acc', 'hsa_net', 'hsa_ver', 'hsa_la', 'hsa_ol', 'hsa_kw',
]);

// =============================================================================
// APPROVED DOMAINS — DB-backed cache
// =============================================================================

const CACHE_TTL_MS = 60_000;
let cachedDomains: Set<string> | null = null;
let cachedAt = 0;

/** Load all approved domains, with a 60s in-process cache. */
async function loadApprovedDomains(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedDomains && now - cachedAt < CACHE_TTL_MS) return cachedDomains;

  const { data, error } = await supabaseAdmin
    .from('approved_domains')
    .select('domain');

  if (error) {
    console.error('[URL] Failed to load approved_domains:', error.message);
    // Fall back to last cache if we have one; otherwise empty (deny-all).
    return cachedDomains || new Set();
  }

  cachedDomains = new Set((data || []).map((r) => (r.domain as string).toLowerCase()));
  cachedAt = now;
  return cachedDomains;
}

/** Force a cache refresh — call after adding/removing approved domains. */
export function invalidateApprovedDomainsCache(): void {
  cachedDomains = null;
  cachedAt = 0;
}

/**
 * Check whether a hostname matches an approved domain or any of its subdomains.
 * Walks up the hostname labels: `events.foo.com` matches an approved `foo.com`.
 */
function hostnameIsApproved(hostname: string, approved: Set<string>): boolean {
  const lower = hostname.toLowerCase();
  if (approved.has(lower)) return true;
  const labels = lower.split('.');
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (approved.has(suffix)) return true;
  }
  return false;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Strip tracking parameters from a URL.
 * Returns the cleaned URL string, or the original if parsing fails.
 */
export function sanitizeUrl(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Log-only approved-domain check. Used by portal/admin/CSV paths where
 * the goal is observability, not enforcement. Sync signature is preserved
 * for existing callers; the DB lookup runs fire-and-forget.
 */
export function checkApprovedDomain(url: string): void {
  if (!url) return;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return;
  }
  void loadApprovedDomains().then((approved) => {
    if (!hostnameIsApproved(hostname, approved)) {
      console.log(`[PORTAL] Non-approved link domain: ${hostname}`);
    }
  });
}

