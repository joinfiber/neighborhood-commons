-- ============================================================================
-- Migration 059: Atomic Contribute API rate limiting (S7)
-- ============================================================================
-- The old check in contribute.ts's checkContributeRateLimit() read event
-- counts from the events table, decided, then the handler inserted. Two
-- concurrent batches at the limit boundary both saw "under limit" and both
-- succeeded, producing (limit + N) inserts instead of the documented cap.
--
-- Fix: dedicated counter table + atomic upsert RPC. Reservation happens in
-- one statement that either increments *and* passes the limit, or leaves
-- the count unchanged and reports 'hourly'. Serializing on the
-- (key_feed, bucket_hour) row makes the hourly check genuinely atomic.
--
-- Daily totals sum across the last 24 hours of bucket rows. Checked AFTER
-- the hourly reservation succeeds; if daily would be over, we revert the
-- hourly increment in the same transaction. Within one hour, all callers
-- serialize on the same row, so the daily check sees a consistent view.
-- Across hour boundaries, there's a minor TOCTOU window where two callers
-- could both pass a daily check that's right at the edge — accepted, since
-- the hourly bound caps the worst case at (hourly_limit) extra events
-- right at an hour-boundary transition.

CREATE TABLE IF NOT EXISTS api_key_rate_usage (
  key_feed TEXT NOT NULL,
  -- Truncated to the hour (date_trunc('hour', now())); each row counts the
  -- reservations made during a single (key_feed, hour) pair.
  bucket_hour TIMESTAMPTZ NOT NULL,
  reservation_count INTEGER NOT NULL DEFAULT 0 CHECK (reservation_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key_feed, bucket_hour)
);

-- Daily sum is "all buckets in the last 24 hours for this key". The index
-- supports the range scan used both by the sum and by future cleanup jobs.
CREATE INDEX IF NOT EXISTS idx_api_key_rate_usage_key_bucket
  ON api_key_rate_usage (key_feed, bucket_hour DESC);

-- Secondary index for the eventual cleanup cron: find old rows regardless of key.
CREATE INDEX IF NOT EXISTS idx_api_key_rate_usage_bucket
  ON api_key_rate_usage (bucket_hour);

-- RLS — server-only, default-deny. Only service_role (supabaseAdmin) accesses.
ALTER TABLE api_key_rate_usage ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE api_key_rate_usage IS
  'Per-API-key contribution counts, bucketed by hour. Atomically incremented by reserve_contribute_slot RPC. Cleanup: rows older than 48 hours may be deleted (no cron yet; safe to accumulate).';

-- ============================================================================
-- RPC: reserve_contribute_slot
-- ----------------------------------------------------------------------------
-- Atomically reserves p_count slots for the calling key. Returns one of:
--   'ok'     — slots reserved, proceed with insert
--   'hourly' — would exceed hourly limit, no reservation made
--   'daily'  — would exceed daily limit, no reservation made
--
-- Callers: contribute.ts::checkContributeRateLimit. Every successful return
-- of 'ok' counts as N events reserved against the key's limits, regardless
-- of whether the subsequent INSERT into events succeeds. This slightly
-- tightens the semantics vs. the old "count actual inserts" behavior —
-- acceptable since a caller whose inserts fail is not a normal use case.
-- ============================================================================

CREATE OR REPLACE FUNCTION reserve_contribute_slot(
  p_key_feed TEXT,
  p_count INTEGER,
  p_hourly_limit INTEGER,
  p_daily_limit INTEGER
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_hour_bucket TIMESTAMPTZ := date_trunc('hour', now());
  v_day_threshold TIMESTAMPTZ := now() - interval '24 hours';
  v_updated_count INTEGER;
  v_daily_sum INTEGER;
BEGIN
  -- Defensive input validation
  IF p_count <= 0 THEN
    RAISE EXCEPTION 'p_count must be positive, got %', p_count;
  END IF;
  IF p_hourly_limit <= 0 OR p_daily_limit <= 0 THEN
    RAISE EXCEPTION 'limits must be positive';
  END IF;

  -- Atomic hourly upsert. The WHERE clause on DO UPDATE prevents the update
  -- from exceeding the limit — if it would, the UPDATE is skipped and
  -- RETURNING yields NULL, which we detect via v_updated_count IS NULL.
  --
  -- On no conflict (first reservation in this bucket), INSERT always fires
  -- and RETURNING yields the inserted count. No WHERE clause applies to the
  -- INSERT, so a single oversized p_count could seed a bucket over limit —
  -- guard against that explicitly.
  IF p_count > p_hourly_limit THEN
    RETURN 'hourly';
  END IF;

  INSERT INTO api_key_rate_usage (key_feed, bucket_hour, reservation_count, updated_at)
  VALUES (p_key_feed, v_hour_bucket, p_count, now())
  ON CONFLICT (key_feed, bucket_hour) DO UPDATE
    SET reservation_count = api_key_rate_usage.reservation_count + p_count,
        updated_at = now()
    WHERE api_key_rate_usage.reservation_count + p_count <= p_hourly_limit
  RETURNING reservation_count INTO v_updated_count;

  IF v_updated_count IS NULL THEN
    -- UPDATE was skipped: hourly limit would be exceeded.
    RETURN 'hourly';
  END IF;

  -- Hourly reservation succeeded. Now check daily.
  SELECT COALESCE(SUM(reservation_count), 0) INTO v_daily_sum
  FROM api_key_rate_usage
  WHERE key_feed = p_key_feed AND bucket_hour > v_day_threshold;

  IF v_daily_sum > p_daily_limit THEN
    -- Revert the hourly reservation we just made, in this same transaction.
    UPDATE api_key_rate_usage
    SET reservation_count = reservation_count - p_count,
        updated_at = now()
    WHERE key_feed = p_key_feed AND bucket_hour = v_hour_bucket;
    RETURN 'daily';
  END IF;

  RETURN 'ok';
END;
$$;

-- Service role only; not callable by anon/authenticated roles directly.
REVOKE EXECUTE ON FUNCTION reserve_contribute_slot FROM PUBLIC, authenticated, anon;

COMMENT ON FUNCTION reserve_contribute_slot IS
  'Atomic Contribute API rate limit reservation. Returns ''ok''|''hourly''|''daily''. See migration 059 for threat model and semantics.';
