-- =============================================================================
-- Groups: the entity resource type in Neighborhood Commons
--
-- A group is any entity that does things in a neighborhood: a business,
-- a community group, a nonprofit, a curator, an informal collective.
-- Groups are the neutral identity atom — who's doing what, where.
--
-- Events link to groups via group_id. A group can operate at multiple
-- venues. A venue can host multiple groups. The relationship is many-to-many.
-- =============================================================================

-- Create the groups table
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'business'
    CHECK (type IN ('business', 'community_group', 'nonprofit', 'collective', 'curator')),

  -- Categorization
  category_tags TEXT[] DEFAULT '{}',

  -- Location
  neighborhood TEXT,
  city TEXT DEFAULT 'Philadelphia',
  address TEXT,
  latitude DECIMAL,
  longitude DECIMAL,

  -- Presence
  avatar_url TEXT,
  hero_image_url TEXT,
  links JSONB DEFAULT '{}',
  phone TEXT,
  website TEXT,

  -- Business-specific
  operating_hours JSONB,

  -- Status
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'dormant', 'pending', 'suspended')),
  claimed BOOLEAN DEFAULT FALSE,

  -- Provenance
  source_publisher TEXT,
  source_method TEXT DEFAULT 'portal'
    CHECK (source_method IN ('portal', 'api', 'feed', 'admin', 'merrie')),

  -- Link to portal account (if this group was seeded from one)
  portal_account_id UUID REFERENCES portal_accounts(id),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_groups_type ON groups(type);
CREATE INDEX IF NOT EXISTS idx_groups_status ON groups(status);
CREATE INDEX IF NOT EXISTS idx_groups_slug ON groups(slug);
CREATE INDEX IF NOT EXISTS idx_groups_neighborhood ON groups(neighborhood);
CREATE INDEX IF NOT EXISTS idx_groups_portal_account ON groups(portal_account_id);

-- Enable RLS (public read, service role write)
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;

-- Public read policy
CREATE POLICY "groups_public_read" ON groups
  FOR SELECT
  USING (status IN ('active', 'dormant'));

-- Service role bypasses RLS, so admin/system operations work without policies.
-- Authenticated users cannot write to groups directly — all writes go through
-- the Express API using supabaseAdmin.

-- =============================================================================
-- Add group_id to events table
-- =============================================================================

ALTER TABLE events
ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id);

CREATE INDEX IF NOT EXISTS idx_events_group_id ON events(group_id);

-- =============================================================================
-- Group-venue linking (many-to-many)
-- A business can operate at multiple venues; a venue can host multiple groups.
-- =============================================================================

CREATE TABLE IF NOT EXISTS group_venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  place_id TEXT,
  venue_name TEXT NOT NULL,
  venue_address TEXT,
  latitude DECIMAL,
  longitude DECIMAL,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, place_id)
);

CREATE INDEX IF NOT EXISTS idx_group_venues_group ON group_venues(group_id);

ALTER TABLE group_venues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "group_venues_public_read" ON group_venues
  FOR SELECT
  USING (true);

-- =============================================================================
-- Seed groups from existing portal accounts
-- Each active portal account becomes a group with type='business'
-- =============================================================================

INSERT INTO groups (
  name, slug, description, type, address, phone, website,
  operating_hours, status, claimed, source_method, portal_account_id,
  latitude, longitude
)
SELECT
  pa.business_name,
  COALESCE(pa.slug, 'acct-' || LEFT(pa.id::text, 8)),
  pa.description,
  'business',
  pa.default_address,
  pa.phone,
  pa.website,
  pa.operating_hours,
  CASE
    WHEN pa.status = 'active' THEN 'active'
    WHEN pa.status = 'pending' THEN 'pending'
    ELSE 'dormant'
  END,
  pa.claimed_at IS NOT NULL,
  'portal',
  pa.id,
  pa.default_latitude,
  pa.default_longitude
FROM portal_accounts pa
WHERE pa.status IN ('active', 'pending')
ON CONFLICT DO NOTHING;

-- Link events to their group via creator_account_id → portal_account_id → group
UPDATE events e
SET group_id = g.id
FROM groups g
WHERE g.portal_account_id = e.creator_account_id
  AND e.group_id IS NULL;

-- Seed group_venues from portal accounts that have a default venue
INSERT INTO group_venues (group_id, place_id, venue_name, venue_address, latitude, longitude, is_primary)
SELECT
  g.id,
  pa.default_place_id,
  pa.default_venue_name,
  pa.default_address,
  pa.default_latitude,
  pa.default_longitude,
  TRUE
FROM groups g
JOIN portal_accounts pa ON pa.id = g.portal_account_id
WHERE pa.default_venue_name IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON TABLE groups IS 'Neighborhood entities: businesses, community groups, curators, nonprofits. The neutral identity atom.';
COMMENT ON COLUMN groups.type IS 'Entity type: business, community_group, nonprofit, collective, curator';
COMMENT ON COLUMN groups.operating_hours IS 'Structured weekly hours: 7-element array [Mon..Sun], each {open: bool, ranges: [{start, end}]}';
COMMENT ON COLUMN groups.portal_account_id IS 'Link to the portal account that seeded this group (if any)';
COMMENT ON TABLE group_venues IS 'Many-to-many link between groups and their venues/locations';
