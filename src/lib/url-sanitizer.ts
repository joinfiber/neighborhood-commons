/**
 * URL Sanitizer & Validator
 *
 * Strips tracking parameters from URLs, and validates URLs submitted via
 * the Contribute API against the approved_domains table.
 *
 * Two surfaces:
 *  - sanitizeUrl(url): strip tracking params. Used everywhere.
 *  - checkApprovedDomain(url): log-only domain check. Used by portal/admin
 *    paths where we don't want to reject — only observe.
 *  - validateContributeUrl(url): full normalcy + allowlist check. Used by
 *    the Contribute API. Rejects malformed/dangerous URLs outright; queues
 *    non-allowlisted-but-otherwise-valid URLs for operator review.
 */

import { isIP } from 'net';
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

/**
 * Hostnames that are never legitimate event-link destinations.
 * IP-literal hostnames are blocked separately via net.isIP().
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost'];

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

/** Result of validating a URL submitted via the Contribute API. */
export type ContributeUrlValidation =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string; domain?: string };

/**
 * Validate a URL submitted via the Contribute API.
 *
 * Hard reject (returns ok:false):
 *  - Unparseable URL
 *  - Scheme other than http/https
 *  - Embedded credentials (user:pass@host)
 *  - IP-literal hostname
 *  - Localhost / .local / .internal / .localhost
 *
 * Soft reject (returns ok:false with code DOMAIN_PENDING_REVIEW):
 *  - Hostname not on approved_domains. The caller should additionally enqueue
 *    a row in domain_approval_requests via queueDomainApprovalRequest().
 *
 * On success: coerces http→https, strips tracking params, returns the cleaned URL.
 */
export async function validateContributeUrl(url: string): Promise<ContributeUrlValidation> {
  if (!url) return { ok: true, url };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'URL is malformed.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'INVALID_SCHEME',
      message: `URL scheme '${parsed.protocol.replace(':', '')}' is not allowed. Use http or https.`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      code: 'URL_CREDENTIALS',
      message: 'URL must not contain embedded credentials.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // IP literals (v4 or v6) — net.isIP returns 0 for non-IPs. Strip brackets for v6.
  const hostForIpCheck = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (isIP(hostForIpCheck) !== 0) {
    return {
      ok: false,
      code: 'IP_LITERAL',
      message: 'URL hostname must be a domain name, not an IP address.',
    };
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      ok: false,
      code: 'BLOCKED_HOSTNAME',
      message: `URL hostname '${hostname}' is not a valid public destination.`,
    };
  }

  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return {
        ok: false,
        code: 'BLOCKED_HOSTNAME',
        message: `URL hostname '${hostname}' is not a valid public destination.`,
      };
    }
  }

  // Coerce http → https
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';

  // Approved-domain check
  const approved = await loadApprovedDomains();
  if (!hostnameIsApproved(hostname, approved)) {
    return {
      ok: false,
      code: 'DOMAIN_PENDING_REVIEW',
      message: `Domain '${hostname}' is pending review and cannot yet be published to the commons.`,
      domain: hostname,
    };
  }

  // Strip tracking params via existing sanitizer
  const sanitized = sanitizeUrl(parsed.toString());
  return { ok: true, url: sanitized };
}

/**
 * Insert a row in domain_approval_requests for operator review.
 * Idempotent: if a pending row for this domain already exists, the
 * unique-index violation is swallowed (we keep the original request context).
 */
export async function queueDomainApprovalRequest(params: {
  domain: string;
  apiKeyId: string;
  url: string;
  eventContext?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('domain_approval_requests').insert({
    domain: params.domain,
    requested_via_api_key: params.apiKeyId,
    requested_url: params.url,
    event_context: params.eventContext || null,
  });
  // 23505 = unique constraint violation (a pending row already exists). Fine.
  if (error && error.code !== '23505') {
    console.error('[URL] Failed to queue domain approval request:', error.message);
  }
}
