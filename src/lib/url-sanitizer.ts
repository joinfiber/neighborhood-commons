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

/** Approved domains for event links. Log-only for portal, enforced for contribute API. */
const APPROVED_DOMAINS = new Set([
  // Ticketing
  'eventbrite.com', 'dice.fm', 'ra.com', 'ticketmaster.com', 'axs.com',
  'seetickets.com', 'showclix.com', 'ticketweb.com', 'etix.com',
  'shotgun.live', 'skiddle.com', 'resident-advisor.net',
  'eventcreate.com', 'humanitix.com', 'tickettailor.com', 'universe.com',
  'brownpapertickets.com', 'ticketleap.com', 'zeffy.com',
  // Social
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'threads.net', 'bsky.app', 'mastodon.social',
  // Event platforms
  'meetup.com', 'lu.ma', 'partiful.com', 'splash.com', 'posh.vip',
  'eventbrite.co.uk', 'allevents.in', 'do512.com', 'splashthat.com',
  // Community / civic
  'nextdoor.com', 'patch.com', 'eventful.com',
  // Payment
  'venmo.com', 'paypal.com', 'paypal.me', 'cash.app', 'gofundme.com',
  // Business / listings
  'yelp.com', 'google.com', 'maps.google.com', 'tripadvisor.com',
  // Website builders (venue and org sites)
  'squarespace.com', 'wix.com', 'wordpress.com', 'carrd.co', 'webflow.io',
  'weebly.com', 'godaddy.com', 'shopify.com', 'notion.site',
  'sites.google.com', 'blogger.com', 'ghost.io', 'substack.com',
  // Link aggregators
  'linktr.ee', 'linkin.bio', 'beacons.ai', 'bio.link', 'lnk.bio',
  // Local Philly
  'uwishunu.com', 'visitphilly.com', 'phillymag.com', 'billypenn.com',
  'thephiladelphiacitizen.org', 'whyy.org',
  // Neighborhood Commons ecosystem
  'merrie.co', 'joinfiber.app', 'commons.joinfiber.app',
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
 * Used by portal routes.
 */
export function checkApprovedDomain(url: string): boolean {
  if (!url) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
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

/**
 * Check if a URL's domain is on the approved list.
 * Returns { approved, domain } — used by contribute API to reject with a clear error.
 */
export function checkContributeUrlDomain(url: string): { approved: boolean; domain: string } {
  if (!url) return { approved: true, domain: '' };
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const domain of APPROVED_DOMAINS) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return { approved: true, domain: hostname };
      }
    }
    console.log(`[CONTRIBUTE] Non-approved URL domain: ${hostname}`);
    return { approved: false, domain: hostname };
  } catch {
    return { approved: false, domain: 'invalid' };
  }
}
