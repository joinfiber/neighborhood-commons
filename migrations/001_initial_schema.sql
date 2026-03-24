-- ============================================================================
-- Neighborhood Commons: Initial Schema Migration
--
-- Creates the complete database schema for the Neighborhood Commons
-- Supabase instance. This is a public events data service.
--
-- Tables:
--   events               -- the canonical public event record
--   portal_accounts      -- business identities
--   regions              -- geographic boundaries
--   event_series         -- recurrence templates
--   event_analytics      -- anonymous aggregate counters
--   event_calendar_adds  -- calendar-add counter
--   event_interested     -- interested counter
--   browse_event_dedup   -- IP dedup (24h TTL)
--   api_keys             -- partner API keys
--   webhook_subscriptions -- push notification subscriptions
--   webhook_deliveries   -- delivery log + retry queue
--   audit_logs           -- portal action audit trail
--
-- Design:
--   - Public read access for events and regions (anon + authenticated)
--   - All writes go through the API (service_role only for most tables)
--   - Portal accounts: own-account access via auth_user_id = auth.uid()
--   - Anonymous aggregate counters only -- no individual user tracking
--   - PostGIS for geographic queries
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

  -- Timezone for event time display
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',

  -- Active flag (soft disable regions)
  is_active boolean DEFAULT true NOT NULL,

  -- Timestamps
  created_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE regions IS
  'Named geographic areas for event targeting. Hierarchical: metro > city > neighborhood.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_regions_type_active ON regions(type) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_regions_parent ON regions(parent_id);
CREATE INDEX IF NOT EXISTS idx_regions_bounds_gist ON regions USING GIST (bounds);
CREATE INDEX IF NOT EXISTS idx_regions_centroid_gist ON regions USING GIST (centroid);

-- RLS
ALTER TABLE regions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "regions_public_read"
  ON regions FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "regions_service_role_all"
  ON regions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 2: portal_accounts
-- ============================================================================
-- Business identities. Authenticate via Supabase Auth (email OTP).
-- Admin seeds accounts; businesses claim by logging in with matching email.

CREATE TABLE IF NOT EXISTS portal_accounts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Links to auth.users when business claims their account.
  -- NULL until claimed.
  auth_user_id uuid UNIQUE,

  -- Identity
  email text NOT NULL UNIQUE,
  business_name text NOT NULL,
  phone text,
  website_url text,

  -- Default venue (pre-populated by admin, used as form defaults)
  venue_name text,
  venue_address text,
  place_id text,
  latitude double precision,
  longitude double precision,

  -- Branding
  logo_url text,
  description text,

  -- Status
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'rejected', 'suspended')),

  -- Claim tracking
  claimed_at timestamptz,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE portal_accounts IS
  'Business accounts for the events portal. Admin seeds; businesses claim via email OTP.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_portal_accounts_email ON portal_accounts (lower(email));

-- Trigger: auto-update updated_at
CREATE TRIGGER portal_accounts_updated_at
  BEFORE UPDATE ON portal_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE portal_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "portal_accounts_select_own"
  ON portal_accounts FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY "portal_accounts_update_own"
  ON portal_accounts FOR UPDATE
  TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY "portal_accounts_service_role_all"
  ON portal_accounts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 3: event_series
-- ============================================================================
-- Recurrence templates for recurring events.

CREATE TABLE IF NOT EXISTS event_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Creator
  creator_account_id uuid REFERENCES portal_accounts(id) ON DELETE CASCADE,

  -- Recurrence rule
  recurrence text NOT NULL DEFAULT 'none'
    CHECK (recurrence IN ('none', 'daily', 'weekly', 'biweekly', 'monthly')),

  -- Template data for generating instances
  base_event_data jsonb,

  -- Timestamps
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE event_series IS
  'Recurring event series metadata and templates.';

-- Trigger: auto-update updated_at
CREATE TRIGGER event_series_updated_at
  BEFORE UPDATE ON event_series
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE event_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_series_service_role_all"
  ON event_series FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 4: events
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
  category text,
  custom_category text,
  price text,

  -- Links and media
  link_url text,
  event_image_url text,
  event_image_focal_y real DEFAULT 0.5
    CHECK (event_image_focal_y >= 0.0 AND event_image_focal_y <= 1.0),

  -- Source and ownership
  source text CHECK (source IN ('portal', 'admin')),
  creator_account_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  user_id uuid,
  is_business boolean DEFAULT false NOT NULL,

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
  'Event origin: portal (business-posted) or admin (admin-seeded).';
COMMENT ON COLUMN events.visibility IS
  'Always "public" for Commons events. Column retained for API compatibility.';
COMMENT ON COLUMN events.location IS
  'PostGIS geography point computed from latitude/longitude.';
COMMENT ON COLUMN events.approximate_location IS
  'Approximate location for privacy-aware display (e.g., neighborhood-level).';
COMMENT ON COLUMN events.becomes_visible_at IS
  'When this event surfaces in feeds. NULL = always visible. Used for future series instances.';

-- Trigger: auto-update updated_at
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

-- RLS
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Public read: anyone can read published events (including anon)
CREATE POLICY "events_public_read"
  ON events FOR SELECT
  TO anon, authenticated
  USING (true);

-- Writes: service_role only (all writes go through the API)
CREATE POLICY "events_service_role_all"
  ON events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Portal accounts can manage their own events via authenticated role
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

-- ============================================================================
-- TABLE 5: event_analytics
-- ============================================================================
-- Anonymous aggregate counters for events. No individual user tracking.

CREATE TABLE IF NOT EXISTS event_analytics (
  event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,

  -- Aggregate counts (NO individual user data -- privacy first)
  opens_count integer DEFAULT 0 NOT NULL,
  interested_count integer DEFAULT 0 NOT NULL,
  coming_count integer DEFAULT 0 NOT NULL,
  shown_up_count integer DEFAULT 0 NOT NULL,

  -- Trending score (computed from weighted combination of counters)
  trending_score real DEFAULT 0 NOT NULL,

  -- Last updated timestamp
  updated_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE event_analytics IS
  'Aggregate-only analytics for events. No individual user tracking -- privacy by design.';

-- RLS: service_role only
ALTER TABLE event_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_analytics_service_role_all"
  ON event_analytics FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 6: event_calendar_adds
-- ============================================================================
-- Anonymous calendar-add counter per event.

CREATE TABLE IF NOT EXISTS event_calendar_adds (
  event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  count integer DEFAULT 0 NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE event_calendar_adds IS
  'Anonymous calendar-add counter for browse screen. Aggregate only -- no individual tracking.';

-- RLS: service_role only
ALTER TABLE event_calendar_adds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_calendar_adds_service_role_all"
  ON event_calendar_adds FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 7: event_interested
-- ============================================================================
-- Anonymous interested counter per event.

CREATE TABLE IF NOT EXISTS event_interested (
  event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  count integer DEFAULT 0 NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE event_interested IS
  'Anonymous interested counter for browse screen. Aggregate only -- for admin analytics.';

-- RLS: service_role only
ALTER TABLE event_interested ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_interested_service_role_all"
  ON event_interested FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 8: browse_event_dedup
-- ============================================================================
-- IP-hash dedup for anonymous counters. Rows older than 24h deleted by cron.

CREATE TABLE IF NOT EXISTS browse_event_dedup (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ip_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('calendar_add', 'view', 'interested')),
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(event_id, ip_hash, action)
);

CREATE INDEX IF NOT EXISTS idx_browse_event_dedup_created
  ON browse_event_dedup(created_at);

COMMENT ON TABLE browse_event_dedup IS
  'Ephemeral IP dedup for anonymous counters. Rows older than 24h deleted by cleanup cron.';

-- RLS: service_role only
ALTER TABLE browse_event_dedup ENABLE ROW LEVEL SECURITY;

CREATE POLICY "browse_event_dedup_service_role_all"
  ON browse_event_dedup FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 9: api_keys
-- ============================================================================
-- Partner API keys with rate limit tiers.

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- The API key value (stored as plaintext for simplicity in initial build;
  -- production should use key_hash with SHA-256)
  key text NOT NULL UNIQUE,

  -- Human label
  name text NOT NULL,

  -- Rate limits
  tier text NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'pro', 'partner')),
  rate_limit_per_hour integer NOT NULL DEFAULT 1000,

  -- Owner
  owner_email text NOT NULL,

  -- Status
  is_active boolean DEFAULT true NOT NULL,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE api_keys IS
  'Partner API keys for the Neighborhood API. Tiered rate limits: free/pro/partner.';

-- RLS: service_role only
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_keys_service_role_all"
  ON api_keys FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 10: webhook_subscriptions
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
CREATE TRIGGER webhook_subscriptions_updated_at
  BEFORE UPDATE ON webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: service_role only
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_subscriptions_service_role_all"
  ON webhook_subscriptions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 11: webhook_deliveries
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

-- RLS: service_role only
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_deliveries_service_role_all"
  ON webhook_deliveries FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TABLE 12: audit_logs
-- ============================================================================
-- Portal action audit trail. Privacy-preserving: actor identifiers are hashed.

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event identification
  action text NOT NULL,

  -- Actor (hashed for privacy)
  actor_hash text,

  -- Resource affected
  resource_id uuid,

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

-- RLS: service_role only (no policies for authenticated -- admin reads via service_role)
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY "audit_logs_service_role_all"
  ON audit_logs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- RPC FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- find_user_region: Find the most specific region containing a point
-- ----------------------------------------------------------------------------
-- Returns the most specific region (neighborhood > city > metro).
-- Used transiently -- location is NOT stored.

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
-- increment_event_opens: Increment opens counter for an event
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION increment_event_opens(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  INSERT INTO event_analytics (event_id, opens_count)
  VALUES (p_event_id, 1)
  ON CONFLICT (event_id) DO UPDATE
  SET
    opens_count = event_analytics.opens_count + 1,
    updated_at = now();
END;
$$;

COMMENT ON FUNCTION increment_event_opens IS
  'Increment opens count for an event. Anonymous -- only stores count, not who viewed.';

-- ----------------------------------------------------------------------------
-- increment_calendar_add: Increment calendar-add counter with IP dedup
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION increment_calendar_add(
  p_event_id uuid,
  p_ip_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- Attempt dedup insert (fails silently on conflict = already counted)
  INSERT INTO browse_event_dedup (event_id, ip_hash, action)
  VALUES (p_event_id, p_ip_hash, 'calendar_add')
  ON CONFLICT DO NOTHING;

  IF NOT FOUND THEN
    RETURN false; -- Already counted today
  END IF;

  -- Increment counter
  INSERT INTO event_calendar_adds (event_id, count)
  VALUES (p_event_id, 1)
  ON CONFLICT (event_id) DO UPDATE
  SET count = event_calendar_adds.count + 1,
      updated_at = now();

  RETURN true;
END;
$$;

COMMENT ON FUNCTION increment_calendar_add IS
  'Atomically increment calendar-add counter with IP dedup. Returns false if already counted.';

-- ----------------------------------------------------------------------------
-- increment_event_view_deduped: Increment view counter with IP dedup
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION increment_event_view_deduped(
  p_event_id uuid,
  p_ip_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  INSERT INTO browse_event_dedup (event_id, ip_hash, action)
  VALUES (p_event_id, p_ip_hash, 'view')
  ON CONFLICT DO NOTHING;

  IF NOT FOUND THEN
    RETURN false; -- Already counted today
  END IF;

  -- Reuse existing analytics infrastructure
  PERFORM increment_event_opens(p_event_id);
  RETURN true;
END;
$$;

COMMENT ON FUNCTION increment_event_view_deduped IS
  'Increment event opens with IP dedup. Wraps increment_event_opens.';

-- ----------------------------------------------------------------------------
-- increment_event_interested: Increment interested counter with IP dedup
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION increment_event_interested(
  p_event_id uuid,
  p_ip_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  INSERT INTO browse_event_dedup (event_id, ip_hash, action)
  VALUES (p_event_id, p_ip_hash, 'interested')
  ON CONFLICT DO NOTHING;

  IF NOT FOUND THEN
    RETURN false; -- Already counted today
  END IF;

  INSERT INTO event_interested (event_id, count)
  VALUES (p_event_id, 1)
  ON CONFLICT (event_id) DO UPDATE
  SET count = event_interested.count + 1,
      updated_at = now();

  RETURN true;
END;
$$;

COMMENT ON FUNCTION increment_event_interested IS
  'Atomically increment interested counter with IP dedup. Returns false if already counted.';

-- ----------------------------------------------------------------------------
-- recompute_trending_score: Recalculate trending score for an event
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION recompute_trending_score(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_interested integer;
  v_coming integer;
  v_shown_up integer;
  v_calendar integer;
  v_opens integer;
  v_score real;
BEGIN
  -- Get base counts from event_analytics
  SELECT
    COALESCE(ea.interested_count, 0),
    COALESCE(ea.coming_count, 0),
    COALESCE(ea.shown_up_count, 0),
    COALESCE(ea.opens_count, 0)
  INTO v_interested, v_coming, v_shown_up, v_opens
  FROM event_analytics ea
  WHERE ea.event_id = p_event_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Get calendar add count
  SELECT COALESCE(count, 0) INTO v_calendar
  FROM event_calendar_adds
  WHERE event_id = p_event_id;

  IF NOT FOUND THEN
    v_calendar := 0;
  END IF;

  -- Composite score
  v_score := (v_interested * 1.0)
           + (v_coming * 3.0)
           + (v_shown_up * 3.0)
           + (v_calendar * 2.0)
           + (v_opens * 0.1);

  UPDATE event_analytics
  SET trending_score = v_score,
      updated_at = now()
  WHERE event_id = p_event_id;
END;
$$;

COMMENT ON FUNCTION recompute_trending_score IS
  'Recalculate trending score from weighted combination of analytics counters.';

-- ----------------------------------------------------------------------------
-- cleanup_browse_dedup: Purge dedup rows older than 24 hours
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_browse_dedup()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM browse_event_dedup
  WHERE created_at < now() - interval '24 hours';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_browse_dedup IS
  'Delete browse dedup rows older than 24h. Run daily via cron.';

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

-- ============================================================================
-- FUNCTION GRANTS
-- ============================================================================
-- Lock down internal functions. Only service_role should call these directly.
-- The API mediates all access.

-- Browse counter RPCs: callable by anon (public browse page, called via API)
REVOKE ALL ON FUNCTION increment_event_opens(uuid) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION increment_calendar_add(uuid, text) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION increment_event_view_deduped(uuid, text) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION increment_event_interested(uuid, text) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION recompute_trending_score(uuid) FROM PUBLIC, authenticated, anon;

-- Cleanup functions: service_role only (called via cron)
REVOKE ALL ON FUNCTION cleanup_browse_dedup() FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION cleanup_old_audit_logs() FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION cleanup_old_webhook_deliveries() FROM PUBLIC, authenticated, anon;

-- find_user_region: callable by anon + authenticated (used by public browse)
GRANT EXECUTE ON FUNCTION find_user_region(float8, float8) TO anon, authenticated;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
--
-- After applying this migration to a fresh Supabase instance:
--
-- 1. REGIONS: Seed with geographic data (at minimum, your launch city)
-- 2. PORTAL_ACCOUNTS: Seed admin-created business accounts (status='active')
-- 3. API_KEYS: Create initial partner API keys
-- 4. EVENTS: Populate from the social DB's events WHERE source IN ('portal', 'admin')
--    using the SAME UUIDs to maintain soft FK stability
-- 5. EVENT_ANALYTICS: Populate from existing event_analytics data
-- 6. WEBHOOK_SUBSCRIPTIONS: Migrate from social DB with secrets intact
--
-- Cron jobs to configure:
--   - cleanup_browse_dedup()          -- daily, purges 24h-old dedup rows
--   - cleanup_old_audit_logs()        -- daily, purges 90-day-old audit logs
--   - cleanup_old_webhook_deliveries() -- daily, purges 30-day-old delivery logs
