-- ============================================================================
-- Migration 047: Contribution tables for CSV data upload
-- ============================================================================
-- Three tables to support the CSV contribution flow: category mappings (shared
-- knowledge base), contribution batches (upload envelopes), and contribution
-- rows (individual parsed rows with raw + mapped data).
--
-- All tables: RLS enabled, no policies (service-role only via supabaseAdmin).

-- ============================================================================
-- Category Mappings — shared synonym table that grows over time
-- ============================================================================

CREATE TABLE IF NOT EXISTS category_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_term text NOT NULL,
  canonical_category text NOT NULL,
  confidence text NOT NULL DEFAULT 'confirmed'
    CHECK (confidence IN ('auto', 'contributor', 'confirmed')),
  created_by_account_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_term)
);

ALTER TABLE category_mappings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE category_mappings IS
  'Shared category synonym table. Maps contributor terms to canonical EVENT_CATEGORIES keys. Grows with each CSV upload.';

-- Seed common synonyms
INSERT INTO category_mappings (source_term, canonical_category, confidence) VALUES
  -- Direct matches (lowercase of our own labels)
  ('live music', 'live_music', 'confirmed'),
  ('live_music', 'live_music', 'confirmed'),
  ('dj', 'dj_dance', 'confirmed'),
  ('dj & dance', 'dj_dance', 'confirmed'),
  ('dj_dance', 'dj_dance', 'confirmed'),
  ('comedy', 'comedy', 'confirmed'),
  ('comedy show', 'comedy', 'confirmed'),
  ('comedy night', 'comedy', 'confirmed'),
  ('theatre', 'theatre', 'confirmed'),
  ('theater', 'theatre', 'confirmed'),
  ('open mic', 'open_mic', 'confirmed'),
  ('open_mic', 'open_mic', 'confirmed'),
  ('open mic night', 'open_mic', 'confirmed'),
  ('karaoke', 'karaoke', 'confirmed'),
  ('karaoke night', 'karaoke', 'confirmed'),
  ('art', 'art_exhibit', 'confirmed'),
  ('art exhibit', 'art_exhibit', 'confirmed'),
  ('art_exhibit', 'art_exhibit', 'confirmed'),
  ('art & exhibits', 'art_exhibit', 'confirmed'),
  ('gallery', 'art_exhibit', 'confirmed'),
  ('film', 'film', 'confirmed'),
  ('movie', 'film', 'confirmed'),
  ('movies', 'film', 'confirmed'),
  ('screening', 'film', 'confirmed'),
  ('literary', 'literary', 'confirmed'),
  ('book', 'literary', 'confirmed'),
  ('books', 'literary', 'confirmed'),
  ('reading', 'literary', 'confirmed'),
  ('poetry', 'literary', 'confirmed'),
  ('tour', 'tour', 'confirmed'),
  ('tours', 'tour', 'confirmed'),
  ('walking tour', 'tour', 'confirmed'),
  ('happy hour', 'happy_hour', 'confirmed'),
  ('happy_hour', 'happy_hour', 'confirmed'),
  ('market', 'market', 'confirmed'),
  ('farmers market', 'market', 'confirmed'),
  ('flea market', 'market', 'confirmed'),
  ('pop-up', 'market', 'confirmed'),
  ('popup', 'market', 'confirmed'),
  ('market & pop-up', 'market', 'confirmed'),
  ('fitness', 'fitness', 'confirmed'),
  ('workout', 'fitness', 'confirmed'),
  ('yoga', 'fitness', 'confirmed'),
  ('sports', 'sports', 'confirmed'),
  ('sports & rec', 'sports', 'confirmed'),
  ('recreation', 'sports', 'confirmed'),
  ('outdoors', 'outdoors', 'confirmed'),
  ('outdoors & nature', 'outdoors', 'confirmed'),
  ('nature', 'outdoors', 'confirmed'),
  ('hiking', 'outdoors', 'confirmed'),
  ('class', 'class', 'confirmed'),
  ('workshop', 'class', 'confirmed'),
  ('class & workshop', 'class', 'confirmed'),
  ('trivia', 'trivia_games', 'confirmed'),
  ('trivia night', 'trivia_games', 'confirmed'),
  ('trivia & games', 'trivia_games', 'confirmed'),
  ('games', 'trivia_games', 'confirmed'),
  ('game night', 'trivia_games', 'confirmed'),
  ('kids', 'kids_family', 'confirmed'),
  ('family', 'kids_family', 'confirmed'),
  ('kids & family', 'kids_family', 'confirmed'),
  ('community', 'community', 'confirmed'),
  ('community event', 'community', 'confirmed'),
  ('meetup', 'community', 'confirmed'),
  ('volunteer', 'community', 'confirmed'),
  ('food pantry', 'community', 'confirmed'),
  ('food bank', 'community', 'confirmed'),
  ('spectator', 'spectator', 'confirmed'),
  -- Common cross-platform terms
  ('music', 'live_music', 'confirmed'),
  ('concert', 'live_music', 'confirmed'),
  ('performance', 'live_music', 'confirmed'),
  ('dance', 'dj_dance', 'confirmed'),
  ('standup', 'comedy', 'confirmed'),
  ('stand-up', 'comedy', 'confirmed'),
  ('improv', 'comedy', 'confirmed')
ON CONFLICT (source_term) DO NOTHING;

-- ============================================================================
-- Contribution Batches — tracks each CSV upload through its lifecycle
-- ============================================================================

CREATE TABLE IF NOT EXISTS contribution_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_account_id uuid NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'partially_approved', 'rejected')),
  file_name text,
  file_hash text,
  event_timezone text NOT NULL DEFAULT 'America/New_York',
  column_mapping jsonb NOT NULL DEFAULT '{}',
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  error_rows integer NOT NULL DEFAULT 0,
  created_events integer NOT NULL DEFAULT 0,
  reviewer_notes text,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contribution_batches ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_contribution_batches_contributor
  ON contribution_batches(contributor_account_id);

CREATE INDEX IF NOT EXISTS idx_contribution_batches_status
  ON contribution_batches(status);

COMMENT ON TABLE contribution_batches IS
  'CSV upload batch envelopes. Tracks lifecycle from draft through admin review to event creation.';

-- ============================================================================
-- Contribution Rows — individual parsed CSV rows with raw + mapped data
-- ============================================================================

CREATE TABLE IF NOT EXISTS contribution_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES contribution_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw_data jsonb NOT NULL,
  mapped_data jsonb,
  category_source_term text,
  category_mapped_to text,
  validation_errors jsonb DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'valid', 'error', 'skipped', 'created')),
  created_event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contribution_rows ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_contribution_rows_batch
  ON contribution_rows(batch_id);

CREATE INDEX IF NOT EXISTS idx_contribution_rows_status
  ON contribution_rows(batch_id, status);

COMMENT ON TABLE contribution_rows IS
  'Individual CSV rows. Preserves raw data alongside canonical mapping for auditability.';
