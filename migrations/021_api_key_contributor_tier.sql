-- Add contributor tier to api_keys for the write API.
-- Controls whether submitted events auto-publish or go to pending_review.
--   pending  = new contributor, events require admin approval
--   verified = track record established, events auto-publish
--   trusted  = partner app, higher rate limits + auto-publish

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS contributor_tier text NOT NULL DEFAULT 'pending';
