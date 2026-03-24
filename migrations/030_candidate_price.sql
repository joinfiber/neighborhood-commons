-- Add price column to event_candidates so feed/newsletter candidates
-- can carry cost info through to admin review.

ALTER TABLE event_candidates
ADD COLUMN IF NOT EXISTS price text;

COMMENT ON COLUMN event_candidates.price IS
  'Free-text price extracted from feed description or structured data (e.g., "$10", "Free", "$5-$15")';
