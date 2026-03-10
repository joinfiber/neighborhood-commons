/**
 * URL Sanitizer
 *
 * Strips tracking parameters from URLs and logs non-approved domains.
 * Used by portal routes to clean ticket/link URLs before storage.
 */

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

/** Approved domains for event links. Log-only for now. */
const APPROVED_DOMAINS = new Set([
  // Ticketing
  'eventbrite.com', 'dice.fm', 'ra.com', 'ticketmaster.com', 'axs.com',
  'seetickets.com', 'showclix.com', 'ticketweb.com', 'etix.com',
  'shotgun.live', 'skiddle.com', 'resident-advisor.net',
  // Social
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'threads.net',
  // Event platforms
  'meetup.com', 'lu.ma', 'partiful.com', 'splash.com', 'posh.vip',
  // Payment
  'venmo.com', 'paypal.com', 'paypal.me', 'cash.app',
  // Business / listings
  'yelp.com', 'google.com', 'maps.google.com',
  // Website builders
  'squarespace.com', 'wix.com', 'wordpress.com', 'carrd.co', 'webflow.io',
  // Link aggregators
  'linktr.ee', 'linkin.bio', 'beacons.ai', 'bio.link', 'lnk.bio',
  // Local Philly
  'uwishunu.com', 'visitphilly.com',
  // Generic
  'joinfiber.app',
]);

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
 * Check if a URL's domain is on the approved list.
 * Returns true if approved. Logs non-approved domains (does not reject).
 */
export function checkApprovedDomain(url: string): boolean {
  if (!url) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Check exact match or subdomain match (e.g., www.eventbrite.com -> eventbrite.com)
    for (const domain of APPROVED_DOMAINS) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return true;
      }
    }
    console.log(`[PORTAL] Non-approved link domain: ${hostname}`);
    return false;
  } catch {
    return false;
  }
}
