-- ============================================================================
-- Migration 089: event_series identity fields + organizer_org_id
--
-- Completes the event_series primitive. Today it carries recurrence + a
-- template snapshot (base_event_data), but no identity of its own — name and
-- shape are derived from whatever was in the template at materialization time.
-- That's enough to render instances but not enough to address the series as
-- a thing across multiple consumer apps (Merrie, Fiber, future readers).
--
-- This migration adds:
--   - organizer_org_id  — explicit ownership, replaces the implicit
--                         spelunk-through-an-instance pattern at
--                         src/routes/service/series.ts:44
--   - name              — current public identity (renames are forward-only;
--                         past events.content is preserved)
--   - slug              — globally unique URL slug (matches the convention used
--                         for organizations, events, groups)
--   - description       — publisher-authored series description
--   - cover_image_url   — R2-hosted cover image, uploaded via the magic-byte +
--                         Sharp re-encode pipeline
--
-- Backfill: name from base_event_data->>'content'; slug via a PL/pgSQL
-- slugify helper modeled on src/lib/developer-portal/slugify.ts (lowercase,
-- strip apostrophes, non-alnum → hyphen, collide-suffix -2/-3/...);
-- organizer_org_id from any existing instance's organizer.
--
-- name and slug become NOT NULL after backfill. organizer_org_id stays
-- NULLABLE: legacy series whose instances were all deleted have no instance
-- to derive from, and we'd rather not destructively drop those rows in a
-- migration. New series MUST provide organizer_org_id via application-layer
-- validation (the api_key_organization_links check in the series route).
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- =============================================================================
-- Phase 1: add columns (all nullable initially so backfill has room to work)
-- =============================================================================

ALTER TABLE event_series
  ADD COLUMN IF NOT EXISTS organizer_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS name             text,
  ADD COLUMN IF NOT EXISTS slug             text,
  ADD COLUMN IF NOT EXISTS description      text,
  ADD COLUMN IF NOT EXISTS cover_image_url  text;

-- =============================================================================
-- Phase 2: temporary slugify helper (dropped automatically at end of session)
--
-- Mirrors baseSlug() in src/lib/developer-portal/slugify.ts:
--   - lowercase
--   - strip apostrophe variants (', ', ', `, ‛)
--   - replace non-alnum runs with single hyphens
--   - trim leading/trailing hyphens
--   - cap at 100 chars
-- =============================================================================

CREATE OR REPLACE FUNCTION pg_temp.compute_series_base_slug(input text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    substring(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(COALESCE(input, '')), '[''‘’‛`]', '', 'g'),
          '[^a-z0-9]+', '-', 'g'
        ),
        '^-+|-+$', '', 'g'
      )
      FROM 1 FOR 100
    ),
    ''
  );
$$;

-- =============================================================================
-- Phase 3: backfill
-- =============================================================================

DO $$
DECLARE
  ser              record;
  base_slug        text;
  candidate        text;
  suffix           int;
  v_series_count   integer;
  v_organized      integer;
  v_named          integer;
  v_slugged        integer;
BEGIN
  SELECT COUNT(*) INTO v_series_count FROM event_series;
  RAISE NOTICE '=== Migration 089: event_series identity backfill ===';
  RAISE NOTICE 'Total series rows: %', v_series_count;

  -- 3a. organizer_org_id ← any instance's organizer_org_id
  UPDATE event_series es
    SET organizer_org_id = (
      SELECT e.organizer_org_id
      FROM events e
      WHERE e.series_id = es.id
        AND e.organizer_org_id IS NOT NULL
      LIMIT 1
    )
  WHERE es.organizer_org_id IS NULL;

  SELECT COUNT(*) INTO v_organized FROM event_series WHERE organizer_org_id IS NOT NULL;
  RAISE NOTICE 'Step 3a: organizer_org_id filled: % / %', v_organized, v_series_count;

  -- 3b. name ← base_event_data.content (fallback: 'Untitled Series')
  UPDATE event_series
    SET name = COALESCE(
      NULLIF(TRIM(base_event_data->>'content'), ''),
      'Untitled Series'
    )
  WHERE name IS NULL;

  SELECT COUNT(*) INTO v_named FROM event_series WHERE name IS NOT NULL;
  RAISE NOTICE 'Step 3b: name filled: % / %', v_named, v_series_count;

  -- 3c. slug ← slugified name, with -2/-3/... suffix on collision.
  -- Per-row loop is required for collision handling; the existing series
  -- set is small (pre-launch ecosystem), so this is fine.
  FOR ser IN SELECT id, name FROM event_series WHERE slug IS NULL LOOP
    base_slug := pg_temp.compute_series_base_slug(ser.name);

    -- Edge case: name is entirely non-ASCII / non-alphanumeric. Fall back to
    -- an id-derived slug so the constraint can be enforced. Operator can
    -- rename via PATCH /service/series/{id} later.
    IF base_slug IS NULL THEN
      base_slug := 'series-' || left(replace(ser.id::text, '-', ''), 8);
    END IF;

    candidate := base_slug;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM event_series WHERE slug = candidate AND id <> ser.id) LOOP
      suffix := suffix + 1;
      candidate := substring(base_slug || '-' || suffix::text FROM 1 FOR 100);
    END LOOP;

    UPDATE event_series SET slug = candidate WHERE id = ser.id;
  END LOOP;

  SELECT COUNT(*) INTO v_slugged FROM event_series WHERE slug IS NOT NULL;
  RAISE NOTICE 'Step 3c: slug filled: % / %', v_slugged, v_series_count;

  -- Sanity check
  IF v_named <> v_series_count OR v_slugged <> v_series_count THEN
    RAISE WARNING 'Backfill incomplete: % series rows still missing name or slug',
      v_series_count - LEAST(v_named, v_slugged);
  END IF;

  IF v_organized < v_series_count THEN
    RAISE NOTICE 'Note: % series rows have no organizer_org_id (instances orphaned or pre-067). organizer_org_id stays NULL for these.',
      v_series_count - v_organized;
  END IF;
END $$;

-- =============================================================================
-- Phase 4: constraints
-- =============================================================================

-- name and slug are filled for every row by Phase 3.
DO $$ BEGIN
  ALTER TABLE event_series ALTER COLUMN name SET NOT NULL;
EXCEPTION
  WHEN others THEN RAISE NOTICE 'event_series.name SET NOT NULL skipped: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE event_series ALTER COLUMN slug SET NOT NULL;
EXCEPTION
  WHEN others THEN RAISE NOTICE 'event_series.slug SET NOT NULL skipped: %', SQLERRM;
END $$;

-- organizer_org_id stays NULLABLE — legacy orphan series may not have an
-- inferable owner. Application layer enforces NOT NULL for new series.

-- =============================================================================
-- Phase 5: indexes
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_series_slug
  ON event_series(slug);

CREATE INDEX IF NOT EXISTS idx_event_series_organizer_org_id
  ON event_series(organizer_org_id)
  WHERE organizer_org_id IS NOT NULL;

-- =============================================================================
-- Phase 6: column documentation
-- =============================================================================

COMMENT ON COLUMN event_series.organizer_org_id IS
  'Organization that runs this series. Required for new series via application-layer validation. Nullable on legacy rows whose instances were deleted before backfill. Authority checks for series CRUD enforce api_key_organization_links against this value.';

COMMENT ON COLUMN event_series.name IS
  'Current public identity of the series. Renames are forward-only — past instances retain their event-time titles in events.content. See docs/series-as-first-class.md.';

COMMENT ON COLUMN event_series.slug IS
  'Globally unique URL slug. Matches the format used for organizations and groups: lowercase alphanumeric + hyphens, leading alphanumeric, max 100 chars.';

COMMENT ON COLUMN event_series.description IS
  'Publisher-authored description of the series. Not snapshotted into individual instances — the description is a fact about the series itself.';

COMMENT ON COLUMN event_series.cover_image_url IS
  'R2-hosted cover image URL. Uploaded through the existing magic-byte + Sharp re-encode pipeline. Distinct from per-instance event_image_url.';
