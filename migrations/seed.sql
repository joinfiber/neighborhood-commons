-- ============================================================================
-- Neighborhood Commons — Local Development Seed Data
-- ============================================================================
-- Run after 000_full_schema.sql to populate a working local instance.
-- Idempotent: uses ON CONFLICT DO NOTHING.
--
-- Usage:
--   psql $DATABASE_URL -f migrations/seed.sql
--   OR paste into the Supabase SQL editor at http://localhost:54323

-- ─── Region ─────────────────────────────────────────────────────────
-- Philadelphia metro area (bounding box covers greater Philly)

INSERT INTO regions (id, name, slug, type, bounds, centroid, timezone) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Philadelphia',
  'philadelphia',
  'metro',
  ST_GeogFromText('POLYGON((-75.28 39.87, -75.28 40.14, -74.95 40.14, -74.95 39.87, -75.28 39.87))'),
  ST_GeogFromText('POINT(-75.1652 39.9526)'),
  'America/New_York'
) ON CONFLICT (slug) DO NOTHING;

-- ─── Venue Account ──────────────────────────────────────────────────
-- A test venue in Center City

INSERT INTO portal_accounts (id, email, business_name, status, default_venue_name, default_address, default_latitude, default_longitude, claimed_at) VALUES (
  '00000000-0000-0000-0000-000000000010',
  'seed-venue@example.com',
  'The Seed Cafe',
  'active',
  'The Seed Cafe',
  '123 Main St, Philadelphia, PA 19103',
  39.9526,
  -75.1652,
  now()
) ON CONFLICT (email) DO NOTHING;

-- ─── Sample Events ──────────────────────────────────────────────────
-- Four events across different categories, all in the future

INSERT INTO events (id, content, description, event_at, end_time, event_timezone, category, status, source, source_method, creator_account_id, place_name, venue_address, latitude, longitude, region_id) VALUES
(
  '00000000-0000-0000-0000-000000000100',
  'Open Mic Night',
  'Weekly open mic. Sign up at the door. All genres welcome.',
  (now() + interval '2 days'),
  (now() + interval '2 days' + interval '3 hours'),
  'America/New_York',
  'open_mic',
  'published',
  'portal',
  'portal',
  '00000000-0000-0000-0000-000000000010',
  'The Seed Cafe',
  '123 Main St, Philadelphia, PA 19103',
  39.9526, -75.1652,
  '00000000-0000-0000-0000-000000000001'
),
(
  '00000000-0000-0000-0000-000000000101',
  'Saturday Farmers Market',
  'Fresh produce, baked goods, and crafts from local vendors.',
  (now() + interval '5 days'),
  (now() + interval '5 days' + interval '4 hours'),
  'America/New_York',
  'market',
  'published',
  'portal',
  'portal',
  '00000000-0000-0000-0000-000000000010',
  'The Seed Cafe',
  '123 Main St, Philadelphia, PA 19103',
  39.9526, -75.1652,
  '00000000-0000-0000-0000-000000000001'
),
(
  '00000000-0000-0000-0000-000000000102',
  'Community Board Meeting',
  'Monthly meeting to discuss neighborhood improvements and upcoming projects.',
  (now() + interval '7 days'),
  (now() + interval '7 days' + interval '2 hours'),
  'America/New_York',
  'community',
  'published',
  'portal',
  'portal',
  '00000000-0000-0000-0000-000000000010',
  'The Seed Cafe',
  '123 Main St, Philadelphia, PA 19103',
  39.9526, -75.1652,
  '00000000-0000-0000-0000-000000000001'
),
(
  '00000000-0000-0000-0000-000000000103',
  'Trivia Tuesday',
  'Test your knowledge. Teams of up to 6. Prizes for top 3.',
  (now() + interval '3 days'),
  (now() + interval '3 days' + interval '2 hours'),
  'America/New_York',
  'trivia_games',
  'published',
  'portal',
  'portal',
  '00000000-0000-0000-0000-000000000010',
  'The Seed Cafe',
  '123 Main St, Philadelphia, PA 19103',
  39.9526, -75.1652,
  '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT (id) DO NOTHING;
