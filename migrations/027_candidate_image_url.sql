-- 027: Add image URL to event candidates
-- Stores og:image or other image URL discovered by crawling the candidate's source URL.
-- Populated during ingestion, shown in review UI, downloaded + re-encoded on approve.

ALTER TABLE event_candidates
ADD COLUMN IF NOT EXISTS candidate_image_url text;

COMMENT ON COLUMN event_candidates.candidate_image_url IS
  'Image URL discovered from the candidate source_url page (og:image, twitter:image, etc.)';
