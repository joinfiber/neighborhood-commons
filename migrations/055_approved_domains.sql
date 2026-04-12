-- Migration 055: Approved domains for contribute API URLs
--
-- Replaces the hardcoded APPROVED_DOMAINS Set in src/lib/url-sanitizer.ts.
-- Operators can add/remove domains via the Service API without redeploying.
-- Non-approved domains submitted via /contribute are queued for review
-- in domain_approval_requests rather than rejected outright.

CREATE TABLE IF NOT EXISTS approved_domains (
  domain text PRIMARY KEY,
  added_by text,
  reason text,
  added_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE approved_domains ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE approved_domains IS
  'Domains permitted as link_url values via the Contribute API. Service-role only; no policies (deny-by-default for anon/authenticated).';

CREATE TABLE IF NOT EXISTS domain_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  requested_via_api_key uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  requested_url text NOT NULL,
  event_context jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by text
);

ALTER TABLE domain_approval_requests ENABLE ROW LEVEL SECURITY;

-- One pending row per domain; approved/rejected rows preserved for history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_approval_requests_one_pending
  ON domain_approval_requests(domain) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_domain_approval_requests_status
  ON domain_approval_requests(status, requested_at DESC);

COMMENT ON TABLE domain_approval_requests IS
  'Queue of contribute-API URLs whose domain is not on the approved list. Operators review and approve or reject.';

-- Seed from the previously hardcoded list in src/lib/url-sanitizer.ts.
INSERT INTO approved_domains (domain, added_by, reason) VALUES
  -- Ticketing
  ('eventbrite.com', 'seed', 'initial allowlist'),
  ('dice.fm', 'seed', 'initial allowlist'),
  ('ra.com', 'seed', 'initial allowlist'),
  ('ticketmaster.com', 'seed', 'initial allowlist'),
  ('axs.com', 'seed', 'initial allowlist'),
  ('seetickets.com', 'seed', 'initial allowlist'),
  ('showclix.com', 'seed', 'initial allowlist'),
  ('ticketweb.com', 'seed', 'initial allowlist'),
  ('etix.com', 'seed', 'initial allowlist'),
  ('shotgun.live', 'seed', 'initial allowlist'),
  ('skiddle.com', 'seed', 'initial allowlist'),
  ('resident-advisor.net', 'seed', 'initial allowlist'),
  ('eventcreate.com', 'seed', 'initial allowlist'),
  ('humanitix.com', 'seed', 'initial allowlist'),
  ('tickettailor.com', 'seed', 'initial allowlist'),
  ('universe.com', 'seed', 'initial allowlist'),
  ('brownpapertickets.com', 'seed', 'initial allowlist'),
  ('ticketleap.com', 'seed', 'initial allowlist'),
  ('zeffy.com', 'seed', 'initial allowlist'),
  -- Social
  ('instagram.com', 'seed', 'initial allowlist'),
  ('facebook.com', 'seed', 'initial allowlist'),
  ('twitter.com', 'seed', 'initial allowlist'),
  ('x.com', 'seed', 'initial allowlist'),
  ('tiktok.com', 'seed', 'initial allowlist'),
  ('youtube.com', 'seed', 'initial allowlist'),
  ('threads.net', 'seed', 'initial allowlist'),
  ('bsky.app', 'seed', 'initial allowlist'),
  ('mastodon.social', 'seed', 'initial allowlist'),
  -- Event platforms
  ('meetup.com', 'seed', 'initial allowlist'),
  ('lu.ma', 'seed', 'initial allowlist'),
  ('partiful.com', 'seed', 'initial allowlist'),
  ('splash.com', 'seed', 'initial allowlist'),
  ('posh.vip', 'seed', 'initial allowlist'),
  ('eventbrite.co.uk', 'seed', 'initial allowlist'),
  ('allevents.in', 'seed', 'initial allowlist'),
  ('do512.com', 'seed', 'initial allowlist'),
  ('splashthat.com', 'seed', 'initial allowlist'),
  -- Community / civic
  ('nextdoor.com', 'seed', 'initial allowlist'),
  ('patch.com', 'seed', 'initial allowlist'),
  ('eventful.com', 'seed', 'initial allowlist'),
  -- Payment
  ('venmo.com', 'seed', 'initial allowlist'),
  ('paypal.com', 'seed', 'initial allowlist'),
  ('paypal.me', 'seed', 'initial allowlist'),
  ('cash.app', 'seed', 'initial allowlist'),
  ('gofundme.com', 'seed', 'initial allowlist'),
  -- Business / listings
  ('yelp.com', 'seed', 'initial allowlist'),
  ('google.com', 'seed', 'initial allowlist'),
  ('maps.google.com', 'seed', 'initial allowlist'),
  ('tripadvisor.com', 'seed', 'initial allowlist'),
  -- Website builders
  ('squarespace.com', 'seed', 'initial allowlist'),
  ('wix.com', 'seed', 'initial allowlist'),
  ('wordpress.com', 'seed', 'initial allowlist'),
  ('carrd.co', 'seed', 'initial allowlist'),
  ('webflow.io', 'seed', 'initial allowlist'),
  ('weebly.com', 'seed', 'initial allowlist'),
  ('godaddy.com', 'seed', 'initial allowlist'),
  ('shopify.com', 'seed', 'initial allowlist'),
  ('notion.site', 'seed', 'initial allowlist'),
  ('sites.google.com', 'seed', 'initial allowlist'),
  ('blogger.com', 'seed', 'initial allowlist'),
  ('ghost.io', 'seed', 'initial allowlist'),
  ('substack.com', 'seed', 'initial allowlist'),
  -- Link aggregators
  ('linktr.ee', 'seed', 'initial allowlist'),
  ('linkin.bio', 'seed', 'initial allowlist'),
  ('beacons.ai', 'seed', 'initial allowlist'),
  ('bio.link', 'seed', 'initial allowlist'),
  ('lnk.bio', 'seed', 'initial allowlist'),
  -- Local Philly
  ('uwishunu.com', 'seed', 'initial allowlist'),
  ('visitphilly.com', 'seed', 'initial allowlist'),
  ('phillymag.com', 'seed', 'initial allowlist'),
  ('billypenn.com', 'seed', 'initial allowlist'),
  ('thephiladelphiacitizen.org', 'seed', 'initial allowlist'),
  ('whyy.org', 'seed', 'initial allowlist'),
  -- Neighborhood Commons ecosystem
  ('merrie.co', 'seed', 'initial allowlist'),
  ('joinfiber.app', 'seed', 'initial allowlist'),
  ('neighborhood-commons.org', 'seed', 'initial allowlist'),
  ('api.neighborhood-commons.org', 'seed', 'initial allowlist')
ON CONFLICT (domain) DO NOTHING;
