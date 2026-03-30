-- Add 'unpublished' to events status check constraint
-- Used when rejecting contributed events (soft rejection, not deletion)

BEGIN;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN ('draft', 'published', 'pending_review', 'suspended', 'unpublished'));

COMMIT;
