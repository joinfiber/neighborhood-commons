-- Add category and tags columns to event_candidates so LLM classification
-- results carry through to admin review.

ALTER TABLE event_candidates
ADD COLUMN IF NOT EXISTS category text,
ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';

COMMENT ON COLUMN event_candidates.category IS
  'LLM-suggested category from EVENT_CATEGORIES (e.g., "live_music", "community")';
COMMENT ON COLUMN event_candidates.tags IS
  'LLM-suggested tags from EVENT_TAGS (e.g., {"free","outdoor","all-ages"})';
