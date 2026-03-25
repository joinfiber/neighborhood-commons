-- ============================================================================
-- Neighborhood Commons: Consolidated Schema
--
-- This file captures the FINAL database state after all migrations (001–038).
-- It is designed for fresh clones: copy, paste, go.
--
-- Completely idempotent — safe to run on an empty database OR an existing one.
-- All CREATE TABLE use IF NOT EXISTS, all CREATE INDEX use IF NOT EXISTS,
-- all functions use CREATE OR REPLACE.
--
-- Generated from migrations 001–038 on 2026-03-25.
-- ============================================================================

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;

-- ============================================================================
-- UTILITY FUNCTIONS
-- ============================================================================

-- Generic updated_at trigger function (reusable across tables)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TABLE 1: regions
-- ============================================================================
-- Geographic boundaries for event targeting. Hierarchical: metro > city > neighborhood.

CREATE TABLE IF NOT EXISTS regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Region identification
  name text NOT NULL,
  slug text UNIQUE NOT NULL,

  -- Region type (for hierarchy and query optimization)
  type text NOT NULL CHECK (type IN ('city', 'neighborhood', 'metro')),

  -- Parent region (neighborhoods belong to cities, cities belong to metros)
  parent_id uuid REFERENCES regions(id) ON DELETE SET NULL,

  -- Geographic bounds (PostGIS polygon for ST_Within queries)
  bounds geography(polygon, 4326) NOT NULL,

  -- Centroid (for distance calculations and geofencing)
  centroid geography(point, 4326) NOT NULL,

  -- Timezone for event time display (002: default changed from America/Los_Angeles)
  timezone text NOT NULL DEFAULT 'America/New_York',

  -- Active flag (soft disable regions)
  is_active boolean DEFAULT true NOT NULL,

  -- Timestamps (002: added updated_at)
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE regions IS
  'Named geographic areas for event targeting. Hierarchical: metro > city > neighborhood.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_regions_type_active ON regions(type) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_regions_parent ON regions(parent_id);
CREATE INDEX IF NOT EXISTS idx_regions_bounds_gist ON regions USING GIST (bounds);
CREATE INDEX IF NOT EXISTS idx_regions_centroid_gist ON regions USING GIST (centroid);

-- Trigger: auto-update updated_at (002)
DROP TRIGGER IF EXISTS regions_updated_at ON regions;
CREATE TRIGGER regions_updated_at
  BEFORE UPDATE ON regions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE regions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'regions' AND policyname = 'regions_public_read') THEN
    CREATE POLICY "regions_public_read"
      ON regions FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'regions' AND policyname = 'regions_service_role_all') THEN
    CREATE POLICY "regions_service_role_all"
      ON regions FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ============================================================================
-- TABLE 2: portal_accounts
-- ============================================================================
-- Business identities. Authenticate via Supabase Auth (email OTP).

CREATE TABLE IF NOT EXISTS portal_accounts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Links to auth.users when business claims their account
  auth_user_id uuid UNIQUE,

  -- Identity
  email text NOT NULL UNIQUE,
  business_name text NOT NULL,
  phone text,
  website text,                      -- 003: renamed from website_url

  -- Default venue (003: renamed with default_ prefix)
  default_venue_name text,           -- 003: renamed from venue_name
  default_address text,              -- 003: renamed from venue_address
  default_place_id text,             -- 003: renamed from place_id
  default_latitude double precision, -- 003: renamed from latitude
  default_longitude double precision,-- 003: renamed from longitude

  -- Branding
  logo_url text,
  description text,

  -- Profile (022)
  slug text UNIQUE,

  -- Status
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'rejected', 'suspended')),

  -- Accessibility (016)
  wheelchair_accessible boolean DEFAULT NULL,

  -- Operating hours (033)
  operating_hours jsonb DEFAULT NULL,

  -- Claim tracking
  claimed_at timestamptz,

  -- Login tracking (003)
  last_login_at timestamptz,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE portal_accounts IS
  'Business accounts for the events portal. Admin seeds; businesses claim via email OTP.';
COMMENT ON COLUMN portal_accounts.wheelchair_accessible IS
  'Venue-level wheelchair accessibility. NULL = not specified. Inherited by events unless overridden.';
COMMENT ON COLUMN portal_accounts.operating_hours IS
  'Structured weekly hours: 7-element array [Mon..Sun], each {open: bool, ranges: [{start, end}]}';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_portal_accounts_email ON portal_accounts (lower(email));

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS portal_accounts_updated_at ON portal_accounts;
CREATE TRIGGER portal_accounts_updated_at
  BEFORE UPDATE ON portal_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE portal_accounts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'portal_accounts' AND policyname = 'portal_accounts_select_own') THEN
    CREATE POLICY "portal_accounts_select_own"
      ON portal_accounts FOR SELECT
      TO authenticated
      USING (auth_user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'portal_accounts' AND policyname = 'portal_accounts_update_own') THEN
    CREATE POLICY "portal_accounts_update_own"
      ON portal_accounts FOR UPDATE
      TO authenticated
      USING (auth_user_id = auth.uid())
      WITH CHECK (auth_user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'portal_accounts' AND policyname = 'portal_accounts_service_role_all') THEN
    CREATE POLICY "portal_accounts_service_role_all"
      ON portal_accounts FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ============================================================================
-- TABLE 3: event_series
-- ============================================================================
-- Recurrence templates for recurring events.

CREATE TABLE IF NOT EXISTS event_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Creator
  creator_account_id uuid REFERENCES portal_accounts(id) ON DELETE CASCADE,

  -- Recurrence rule (011: expanded regex to include ordinal_weekday and weekly_days)
  recurrence text NOT NULL DEFAULT 'none'
    CONSTRAINT event_series_recurrence_check
    CHECK (
      recurrence ~ '^(none|daily|weekly|biweekly|monthly|ordinal_weekday:[1-5]:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekly_days:(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*)$'
    ),

  -- Template data for generating instances
  base_event_data jsonb,

  -- 006: admin user who created the series
  user_id uuid,

  -- 006: structured recurrence rule (jsonb with frequency + count)
  recurrence_rule jsonb,

  -- Timestamps
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE event_series IS
  'Recurring event templates. RLS enabled, service_role only — '
  'managed exclusively by server code. No authenticated user policies needed.';

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS event_series_updated_at ON event_series;
CREATE TRIGGER event_series_updated_at
  BEFORE UPDATE ON event_series
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS (service_role only — no policies means default deny for anon/authenticated)
ALTER TABLE event_series ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_series' AND policyname = 'event_series_service_role_all') THEN
    CREATE POLICY "event_series_service_role_all"
      ON event_series FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ============================================================================
-- TABLE 4: groups
-- ============================================================================
-- Neighborhood entities: businesses, community groups, curators, nonprofits.

CREATE TABLE IF NOT EXISTS groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  type text NOT NULL DEFAULT 'business'
    CHECK (type IN ('business', 'community_group', 'nonprofit', 'collective', 'curator')),

  -- Categorization
  category_tags text[] DEFAULT '{}',

  -- Location
  neighborhood text,
  city text DEFAULT 'Philadelphia',
  address text,
  latitude decimal,
  longitude decimal,

  -- Presence
  avatar_url text,
  hero_image_url text,
  links jsonb DEFAULT '{}',
  phone text,
  website text,

  -- Business-specific
  operating_hours jsonb,

  -- Status
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'dormant', 'pending', 'suspended')),
  claimed boolean DEFAULT false,

  -- Provenance
  source_publisher text,
  source_method text DEFAULT 'portal'
    CHECK (source_method IN ('portal', 'api', 'feed', 'admin', 'merrie')),

  -- Link to portal account (if seeded from one)
  portal_account_id uuid REFERENCES portal_accounts(id),

  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

COMMENT ON TABLE groups IS 'Neighborhood entities: businesses, community groups, curators, nonprofits. The neutral identity atom.';
COMMENT ON COLUMN groups.type IS 'Entity type: business, community_group, nonprofit, collective, curator';
COMMENT ON COLUMN groups.operating_hours IS 'Structured weekly hours: 7-element array [Mon..Sun], each {open: bool, ranges: [{start, end}]}';
COMMENT ON COLUMN groups.portal_account_id IS 'Link to the portal account that seeded this group (if any)';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_groups_type ON groups(type);
CREATE INDEX IF NOT EXISTS idx_groups_status ON groups(status);
CREATE INDEX IF NOT EXISTS idx_groups_slug ON groups(slug);
CREATE INDEX IF NOT EXISTS idx_groups_neighborhood ON groups(neighborhood);
CREATE INDEX IF NOT EXISTS idx_groups_portal_account ON groups(portal_account_id);

-- RLS (public read for active/dormant; service role bypasses RLS for writes)
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'groups' AND policyname = 'groups_public_read') THEN
    CREATE POLICY "groups_public_read" ON groups
      FOR SELECT
      USING (status IN ('active', 'dormant'));
  END IF;
END $$;

-- ============================================================================
-- TABLE 5: group_venues
-- ============================================================================
-- Many-to-many link between groups and their venues/locations.

CREATE TABLE IF NOT EXISTS group_venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  place_id text,
  venue_name text NOT NULL,
  venue_address text,
  latitude decimal,
  longitude decimal,
  is_primary boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(group_id, place_id)
);

COMMENT ON TABLE group_venues IS 'Many-to-many link between groups and their venues/locations';

CREATE INDEX IF NOT EXISTS idx_group_venues_group ON group_venues(group_id);

ALTER TABLE group_venues ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'group_venues' AND policyname = 'group_venues_public_read') THEN
    CREATE POLICY "group_venues_public_read" ON group_venues
      FOR SELECT
      USING (true);
  END IF;
END $$;

-- ============================================================================
-- TABLE 6: events
-- ============================================================================
-- The canonical public event record. All community events live here.

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event content
  content text NOT NULL,
  description text,

  -- Scheduling
  event_at timestamptz,
  end_time timestamptz,
  event_timezone text DEFAULT 'America/New_York',

  -- Venue
  place_id text,
  place_name text,
  venue_address text,
  latitude double precision,
  longitude double precision,
  location geography(point, 4326),
  approximate_location geography(point, 4326),

  -- Region
  region_id uuid REFERENCES regions(id) ON DELETE SET NULL,

  -- Classification
  category text
    CONSTRAINT events_category_check
    CHECK (category IN (
      'live_music', 'dj_dance', 'comedy', 'theatre', 'open_mic', 'karaoke',
      'art_exhibit', 'film', 'literary', 'tour',
      'happy_hour', 'market',
      'fitness', 'sports', 'outdoors',
      'class', 'trivia_games', 'kids_family',
      'community', 'spectator'
    )),
  custom_category text,
  price text,
  tags text[] DEFAULT '{}',                        -- 015

  -- Links and media
  link_url text,
  event_image_url text,
  event_image_focal_y real DEFAULT 0.5
    CHECK (event_image_focal_y >= 0.0 AND event_image_focal_y <= 1.0),

  -- Source and ownership (023: expanded; 020: contributor columns)
  source text
    CONSTRAINT events_source_check
    CHECK (source IN ('portal', 'admin', 'import', 'api', 'newsletter')),
  creator_account_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  user_id uuid,
  is_business boolean DEFAULT false NOT NULL,
  source_method text NOT NULL DEFAULT 'portal',    -- 020
  source_publisher text,                           -- 020
  source_feed_url text,                            -- 020
  external_id text,                                -- 020

  -- Group link (034)
  group_id uuid REFERENCES groups(id),

  -- Visibility and status
  visibility text DEFAULT 'public'
    CHECK (visibility IN ('public')),
  status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft', 'published', 'pending_review', 'suspended')),
  broadcast_mode text,

  -- Discovery
  discovery_radius_meters integer,

  -- Recurrence
  recurrence text NOT NULL DEFAULT 'none',
  series_id uuid REFERENCES event_series(id) ON DELETE SET NULL,
  series_instance_number integer,

  -- Browse behavior (014)
  start_time_required boolean NOT NULL DEFAULT true,

  -- Accessibility (016)
  wheelchair_accessible boolean DEFAULT NULL,

  -- RSVP (017)
  rsvp_limit integer,

  -- Movie showtimes (029)
  runtime_minutes integer,
  content_rating text,
  showtimes jsonb,

  -- Lifecycle
  becomes_visible_at timestamptz,
  expires_at timestamptz,
  ended_at timestamptz,

  -- Timestamps
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE events IS
  'The canonical public event record. All community events live here.';
COMMENT ON COLUMN events.content IS
  'Event title/name. Named "content" for consistency with social API.';
COMMENT ON COLUMN events.source IS
  'Event origin: portal (business-posted), admin (admin-seeded), import, api, or newsletter.';
COMMENT ON COLUMN events.visibility IS
  'Always "public" for Commons events. Column retained for API compatibility.';
COMMENT ON COLUMN events.location IS
  'PostGIS geography point computed from latitude/longitude.';
COMMENT ON COLUMN events.approximate_location IS
  'Approximate location for privacy-aware display (e.g., neighborhood-level).';
COMMENT ON COLUMN events.becomes_visible_at IS
  'When this event surfaces in feeds. NULL = always visible. Used for future series instances.';
COMMENT ON COLUMN events.start_time_required IS
  'When true, event disappears from browse feeds at start time. When false (open-window events like happy hours), stays visible until end_time.';
COMMENT ON COLUMN events.tags IS
  'Experience/setting/access tags from the shared pool. Validated per category at the application layer.';
COMMENT ON COLUMN events.wheelchair_accessible IS
  'Per-event wheelchair accessibility. NULL = inherit from portal_accounts. Explicit true/false overrides account default.';

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS events_updated_at ON events;
CREATE TRIGGER events_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Trigger: auto-compute location from lat/lng
CREATE OR REPLACE FUNCTION compute_event_location()
RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_compute_location ON events;
CREATE TRIGGER events_compute_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON events
  FOR EACH ROW EXECUTE FUNCTION compute_event_location();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_events_published_active
  ON events(event_at ASC)
  WHERE status = 'published' AND ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_region_created
  ON events(region_id, created_at DESC)
  WHERE status = 'published' AND ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_category
  ON events(category)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_events_creator_account
  ON events(creator_account_id);

CREATE INDEX IF NOT EXISTS idx_events_source
  ON events(source);

CREATE INDEX IF NOT EXISTS idx_events_updated_at
  ON events(updated_at);

CREATE INDEX IF NOT EXISTS idx_events_series
  ON events(series_id, series_instance_number)
  WHERE series_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_tags ON events USING GIN (tags);

-- 020: dedup index for imported events
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_dedup
  ON events (source_feed_url, external_id)
  WHERE source_feed_url IS NOT NULL AND external_id IS NOT NULL;

-- 032: composite index for primary public API query
CREATE INDEX IF NOT EXISTS idx_events_status_event_at
  ON events(status, event_at ASC);

-- 032: composite index for portal dashboard
CREATE INDEX IF NOT EXISTS idx_events_creator_event_at
  ON events(creator_account_id, event_at DESC);

-- 034: group_id index
CREATE INDEX IF NOT EXISTS idx_events_group_id ON events(group_id);

-- RLS
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'events' AND policyname = 'events_public_read') THEN
    CREATE POLICY "events_public_read"
      ON events FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'events' AND policyname = 'events_service_role_all') THEN
    CREATE POLICY "events_service_role_all"
      ON events FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'events' AND policyname = 'events_portal_insert_own') THEN
    CREATE POLICY "events_portal_insert_own"
      ON events FOR INSERT
      TO authenticated
      WITH CHECK (
        source = 'portal'
        AND creator_account_id IS NOT NULL
        AND creator_account_id IN (
          SELECT id FROM portal_accounts WHERE auth_user_id = auth.uid()
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'events' AND policyname = 'events_portal_update_own') THEN
    CREATE POLICY "events_portal_update_own"
      ON events FOR UPDATE
      TO authenticated
      USING (
        source = 'portal'
        AND creator_account_id IS NOT NULL
        AND creator_account_id IN (
          SELECT id FROM portal_accounts WHERE auth_user_id = auth.uid()
        )
      )
      WITH CHECK (
        source = 'portal'
        AND creator_account_id IS NOT NULL
        AND creator_account_id IN (
          SELECT id FROM portal_accounts WHERE auth_user_id = auth.uid()
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'events' AND policyname = 'events_portal_delete_own') THEN
    CREATE POLICY "events_portal_delete_own"
      ON events FOR DELETE
      TO authenticated
      USING (
        source = 'portal'
        AND creator_account_id IS NOT NULL
        AND creator_account_id IN (
          SELECT id FROM portal_accounts WHERE auth_user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ============================================================================
-- TABLE 7: api_keys
-- ============================================================================
-- API keys for the Neighborhood API.
-- 007: hashed keys, status string. 010: NOT NULL on key_hash/prefix/contact.
-- 021: contributor_tier. 037: service tier. 038: dropped legacy tier column.

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- SHA-256 hash of the raw key (plaintext is never stored)
  key_hash text NOT NULL,

  -- First 12 chars for display/identification
  key_prefix text NOT NULL,

  -- Human label
  name text NOT NULL,

  -- Rate limits
  rate_limit_per_hour integer NOT NULL DEFAULT 1000,

  -- Contact
  contact_email text NOT NULL,

  -- Status (007: replaced is_active boolean)
  status text NOT NULL DEFAULT 'active',

  -- Contributor trust level (021, 037)
  contributor_tier text NOT NULL DEFAULT 'pending',

  -- Track last usage (007)
  last_used_at timestamptz,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE api_keys IS
  'API keys for the Neighborhood API. Free, 1000 requests/hour.';
COMMENT ON COLUMN api_keys.contributor_tier IS
  'Contributor trust level: pending (review required), verified (auto-publish), trusted (partner, higher limits), service (full CRUD, admin-level access)';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_contact_email ON api_keys(contact_email);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);

-- RLS: enabled with no policies = default deny for anon/authenticated.
-- service_role bypasses RLS. (009 disabled, 012 re-enabled)
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- TABLE 8: audit_logs
-- ============================================================================
-- Portal action audit trail. Privacy-preserving: actor identifiers are hashed.

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event identification
  action text NOT NULL,

  -- Actor (hashed for privacy)
  actor_hash text,

  -- Resource affected (006: added resource_hash alongside legacy resource_id)
  resource_id uuid,
  resource_hash text,

  -- Result and context (006)
  result text,
  reason text,
  ip_hash text,
  user_agent text,

  -- Extra data
  metadata jsonb DEFAULT '{}',

  -- Context
  endpoint text,

  -- Timing
  created_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE audit_logs IS
  'Portal action audit trail. Actor identifiers are hashed for privacy. Retained 90 days.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_hash ON audit_logs(resource_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_hash ON audit_logs(actor_hash, created_at DESC);

-- RLS: enabled with no policies = default deny. service_role bypasses.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- TABLE 9: webhook_subscriptions
-- ============================================================================
-- Push notification subscriptions for API consumers.

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,

  -- Target
  url text NOT NULL,

  -- Security
  signing_secret text NOT NULL,
  signing_secret_encrypted text,

  -- Events to subscribe to
  event_types text[] NOT NULL DEFAULT '{"event.created","event.updated","event.deleted"}',

  -- Status
  is_active boolean DEFAULT true NOT NULL,

  -- Health tracking
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE webhook_subscriptions IS
  'Webhook push notification subscriptions for API consumers.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_webhook_subs_active
  ON webhook_subscriptions(is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_webhook_subs_key
  ON webhook_subscriptions(api_key_id);

-- Trigger: auto-update updated_at
DROP TRIGGER IF EXISTS webhook_subscriptions_updated_at ON webhook_subscriptions;
CREATE TRIGGER webhook_subscriptions_updated_at
  BEFORE UPDATE ON webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: enabled with no policies = default deny. service_role bypasses.
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- TABLE 10: webhook_deliveries
-- ============================================================================
-- Delivery log for debugging and retry.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,

  -- What was sent
  event_type text NOT NULL,
  event_id uuid NOT NULL,

  -- Delivery result
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
  status_code integer,
  error_message text,

  -- Retry tracking
  attempt integer NOT NULL DEFAULT 1,
  next_retry_at timestamptz,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE webhook_deliveries IS
  'Webhook delivery log for debugging and retry queue.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON webhook_deliveries(next_retry_at)
  WHERE status IN ('pending', 'retrying');

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_age
  ON webhook_deliveries(created_at);

-- 032: retry cron index
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry
  ON webhook_deliveries(next_retry_at)
  WHERE status = 'retrying';

-- RLS: enabled with no policies = default deny. service_role bypasses.
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- TABLE 11: newsletter_sources
-- ============================================================================
-- Newsletter sources for the email ingestion pipeline.

CREATE TABLE IF NOT EXISTS newsletter_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sender_email text,
  notes text,
  auto_approve boolean DEFAULT false,
  status text DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_at timestamptz DEFAULT now(),
  last_received_at timestamptz
);

ALTER TABLE newsletter_sources ENABLE ROW LEVEL SECURITY;
-- No policies: default deny for anon/authenticated. service_role bypasses RLS.

-- ============================================================================
-- TABLE 12: newsletter_emails
-- ============================================================================
-- Raw inbound emails from Mailgun.

CREATE TABLE IF NOT EXISTS newsletter_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES newsletter_sources(id),
  message_id text,
  sender_email text NOT NULL,
  subject text NOT NULL,
  body_html text,
  body_plain text,
  received_at timestamptz DEFAULT now(),
  processing_status text DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  processing_error text,
  candidate_count int,
  llm_response text
);

ALTER TABLE newsletter_emails ENABLE ROW LEVEL SECURITY;

-- Unique on message_id for idempotent Mailgun delivery (nulls excluded)
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_emails_message_id_uniq
  ON newsletter_emails(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS newsletter_emails_source_id_idx ON newsletter_emails(source_id);
CREATE INDEX IF NOT EXISTS newsletter_emails_processing_status_idx ON newsletter_emails(processing_status);

-- ============================================================================
-- TABLE 13: feed_sources
-- ============================================================================
-- Pull-based event ingestion: iCal feeds, RSS feeds, structured APIs.

CREATE TABLE IF NOT EXISTS feed_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  feed_url text NOT NULL,
  feed_type text DEFAULT 'ical'
    CHECK (feed_type IN ('ical', 'rss', 'eventbrite', 'agile_ticketing')),
  poll_interval_hours int DEFAULT 24,
  status text DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'retired')),
  default_location text,
  default_timezone text DEFAULT 'America/New_York',
  notes text,
  created_at timestamptz DEFAULT now(),
  last_polled_at timestamptz,
  last_poll_result text,
  last_poll_error text,
  last_event_count int
);

ALTER TABLE feed_sources ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS feed_sources_status_idx ON feed_sources(status);

-- ============================================================================
-- TABLE 14: event_candidates
-- ============================================================================
-- LLM-extracted event candidates awaiting admin review.
-- Fed by both newsletter emails (025) and feed sources (028).

CREATE TABLE IF NOT EXISTS event_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid REFERENCES newsletter_emails(id),    -- 028: nullable (feed candidates have no email)
  source_id uuid REFERENCES newsletter_sources(id),
  feed_source_id uuid REFERENCES feed_sources(id),   -- 028
  title text NOT NULL,
  description text,
  start_date date,
  start_time time,
  end_time time,
  location_name text,
  location_address text,
  location_lat double precision,
  location_lng double precision,
  source_url text,
  confidence numeric(3,2),
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'duplicate')),
  matched_event_id uuid,
  match_confidence numeric(3,2),
  review_notes text,
  extraction_metadata jsonb,        -- 026
  candidate_image_url text,         -- 027
  price text,                       -- 030
  category text,                    -- 031
  tags text[] DEFAULT '{}',         -- 031
  created_at timestamptz DEFAULT now(),
  reviewed_at timestamptz
);

ALTER TABLE event_candidates ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN event_candidates.extraction_metadata IS
  'Per-field confidence scores and source text excerpts from LLM extraction. Schema: { field_confidence: { title: 0.9, ... }, excerpts: { title: "...", ... } }';
COMMENT ON COLUMN event_candidates.candidate_image_url IS
  'Image URL discovered from the candidate source_url page (og:image, twitter:image, etc.)';
COMMENT ON COLUMN event_candidates.price IS
  'Free-text price extracted from feed description or structured data (e.g., "$10", "Free", "$5-$15")';
COMMENT ON COLUMN event_candidates.category IS
  'LLM-suggested category from EVENT_CATEGORIES (e.g., "live_music", "community")';
COMMENT ON COLUMN event_candidates.tags IS
  'LLM-suggested tags from EVENT_TAGS (e.g., {"free","outdoor","all-ages"})';

CREATE INDEX IF NOT EXISTS event_candidates_email_id_idx ON event_candidates(email_id);
CREATE INDEX IF NOT EXISTS event_candidates_status_idx ON event_candidates(status);
CREATE INDEX IF NOT EXISTS event_candidates_matched_event_id_idx ON event_candidates(matched_event_id);
CREATE INDEX IF NOT EXISTS event_candidates_feed_source_id_idx ON event_candidates(feed_source_id);

-- ============================================================================
-- RPC FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- find_user_region: Find the most specific region containing a point
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION find_user_region(p_longitude float8, p_latitude float8)
RETURNS TABLE (region_id uuid, region_name text, region_type text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT id, name, type
  FROM regions
  WHERE is_active = true
    AND ST_Within(
      ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geometry,
      bounds::geometry
    )
  ORDER BY
    CASE type
      WHEN 'neighborhood' THEN 1
      WHEN 'city' THEN 2
      WHEN 'metro' THEN 3
    END
  LIMIT 1;
$$;

COMMENT ON FUNCTION find_user_region IS
  'Find the most specific region containing a point. Used transiently -- location is NOT stored.';

-- ----------------------------------------------------------------------------
-- cleanup_old_audit_logs: Purge audit logs older than 90 days
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_old_audit_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM audit_logs
  WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_old_audit_logs IS
  'Removes audit logs older than 90 days. Run via cron.';

-- ----------------------------------------------------------------------------
-- cleanup_old_webhook_deliveries: Purge delivery logs older than 30 days
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_old_webhook_deliveries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM webhook_deliveries
  WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_old_webhook_deliveries IS
  'Removes webhook delivery logs older than 30 days. Run via cron.';

-- ----------------------------------------------------------------------------
-- create_webhook_subscription: Atomic subscription creation with limit check
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_webhook_subscription(
  p_api_key_id UUID,
  p_url TEXT,
  p_event_types TEXT[],
  p_signing_secret TEXT,
  p_signing_secret_encrypted BYTEA DEFAULT NULL,
  p_max_subscriptions INT DEFAULT 5
)
RETURNS webhook_subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  current_count INT;
  result webhook_subscriptions%ROWTYPE;
BEGIN
  -- Advisory lock serializes concurrent creates for the same api_key_id
  PERFORM pg_advisory_xact_lock(hashtext(p_api_key_id::text));

  SELECT COUNT(*) INTO current_count
  FROM webhook_subscriptions
  WHERE api_key_id = p_api_key_id;

  IF current_count >= p_max_subscriptions THEN
    RAISE EXCEPTION 'Subscription limit reached (% per key)', p_max_subscriptions
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO webhook_subscriptions (api_key_id, url, event_types, signing_secret, signing_secret_encrypted)
  VALUES (p_api_key_id, p_url, p_event_types, p_signing_secret, p_signing_secret_encrypted)
  RETURNING * INTO result;

  RETURN result;
END;
$$;

-- ----------------------------------------------------------------------------
-- suspend_portal_account: Atomic account suspension with event cascading
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION suspend_portal_account(p_account_id UUID)
RETURNS TABLE(events_suspended BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  UPDATE portal_accounts
  SET status = 'suspended', updated_at = now()
  WHERE id = p_account_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % is not active or does not exist', p_account_id;
  END IF;

  WITH suspended AS (
    UPDATE events
    SET status = 'suspended'
    WHERE creator_account_id = p_account_id
      AND status = 'published'
    RETURNING id
  )
  SELECT count(*) INTO events_suspended FROM suspended;

  RETURN NEXT;
END;
$$;

-- ----------------------------------------------------------------------------
-- reactivate_portal_account: Atomic account reactivation with event cascading
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reactivate_portal_account(p_account_id UUID)
RETURNS TABLE(events_reactivated BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  UPDATE portal_accounts
  SET status = 'active', updated_at = now()
  WHERE id = p_account_id AND status = 'suspended';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % is not suspended or does not exist', p_account_id;
  END IF;

  WITH reactivated AS (
    UPDATE events
    SET status = 'published'
    WHERE creator_account_id = p_account_id
      AND status = 'suspended'
    RETURNING id
  )
  SELECT count(*) INTO events_reactivated FROM reactivated;

  RETURN NEXT;
END;
$$;

-- ============================================================================
-- FUNCTION GRANTS
-- ============================================================================

-- find_user_region: callable by anon + authenticated (used by public browse)
GRANT EXECUTE ON FUNCTION find_user_region(float8, float8) TO anon, authenticated;

-- Cleanup functions: service_role only (called via cron)
REVOKE ALL ON FUNCTION cleanup_old_audit_logs() FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION cleanup_old_webhook_deliveries() FROM PUBLIC, authenticated, anon;

-- Webhook subscription creation: service_role only
REVOKE EXECUTE ON FUNCTION create_webhook_subscription FROM PUBLIC, authenticated, anon;

-- Account suspension/reactivation: service_role only
REVOKE EXECUTE ON FUNCTION suspend_portal_account(UUID) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION reactivate_portal_account(UUID) FROM PUBLIC, authenticated, anon;

-- ============================================================================
-- SCHEMA COMPLETE
-- ============================================================================
--
-- After applying this to a fresh Supabase instance:
--
-- 1. REGIONS: Seed with geographic data (at minimum, your launch city)
-- 2. PORTAL_ACCOUNTS: Seed admin-created business accounts (status='active')
-- 3. API_KEYS: Create initial partner API keys (hashed, with key_prefix)
-- 4. EVENTS: Populate from existing data sources
-- 5. GROUPS: Seed from portal accounts or create directly
-- 6. WEBHOOK_SUBSCRIPTIONS: Configure for downstream consumers
--
-- Cron jobs to configure:
--   - cleanup_old_audit_logs()          -- daily, purges 90-day-old audit logs
--   - cleanup_old_webhook_deliveries()  -- daily, purges 30-day-old delivery logs
