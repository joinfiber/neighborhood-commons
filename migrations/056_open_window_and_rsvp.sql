-- Migration 056: Rename start_time_required -> open_window (inverted),
-- rename rsvp_limit -> capacity, add rsvp enum.
--
-- Context:
--  * start_time_required was poorly named — it really meant "arrival at start
--    is required," which is the inverse of "open window" (come-and-go).
--    open_window reads honestly.
--  * rsvp_limit implied Commons tracks RSVPs; it never did. capacity is what
--    we actually store: informational max attendance. Commons does NOT manage
--    attendance or signups. link_url remains the ticketing surface.
--  * rsvp (nullable enum) is new — a signal to consumer apps whether RSVP
--    is a thing for this event. No enforcement.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS open_window boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS capacity integer,
  ADD COLUMN IF NOT EXISTS rsvp text;

ALTER TABLE events
  ADD CONSTRAINT events_rsvp_check CHECK (rsvp IS NULL OR rsvp IN ('recommended', 'required'));

-- Backfill from legacy fields.
UPDATE events SET open_window = (NOT start_time_required) WHERE start_time_required = false;
UPDATE events SET capacity = rsvp_limit WHERE rsvp_limit IS NOT NULL;

-- Drop the legacy columns — clean break, no dual-write period.
ALTER TABLE events
  DROP COLUMN IF EXISTS start_time_required,
  DROP COLUMN IF EXISTS rsvp_limit;

COMMENT ON COLUMN events.open_window IS
  'True for come-and-go events (happy hour, open swim, market). Feeds keep the event visible until end_time (or start+3h if no end).';

COMMENT ON COLUMN events.capacity IS
  'Informational max attendance. Commons does NOT track signups or enforce the cap — ticketing lives in link_url.';

COMMENT ON COLUMN events.rsvp IS
  'Whether RSVP is a thing for this event. null = no RSVP, ''recommended'' or ''required''. Commons does not manage RSVPs.';
