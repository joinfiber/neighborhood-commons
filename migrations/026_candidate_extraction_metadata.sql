-- 026: Add extraction metadata to event_candidates
-- Stores per-field confidence scores and source excerpts from LLM extraction.
-- Allows reviewers to see why the LLM assigned each value and trace it to the email.

ALTER TABLE event_candidates
ADD COLUMN IF NOT EXISTS extraction_metadata jsonb;

COMMENT ON COLUMN event_candidates.extraction_metadata IS
  'Per-field confidence scores and source text excerpts from LLM extraction. Schema: { field_confidence: { title: 0.9, ... }, excerpts: { title: "...", ... } }';
