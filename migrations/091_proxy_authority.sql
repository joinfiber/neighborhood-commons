-- ============================================================================
-- Migration 091: api_keys.proxy_authority capability flag
--
-- Unlocks the caller-set `proxied` event provenance path for trusted
-- pipeline keys. Mirrors witness_authority (migration 078).
--
-- Background: docs/four-roles.md Path 2 ("Pipeline-proxies") defines proxied
-- as the honest provenance for a tool that scrapes a public page and
-- publishes on behalf of the scraped real-world entity — organizer = the
-- scraped entity, source_feed_url = the page. But until now `proxied` was
-- not caller-settable (the Service API write enum was ['self_asserted',
-- 'witnessed'] and the field doc said "reserved for internal pipeline code
-- paths"). That left external scrape-and-publish pipelines — Studio's
-- porchfest path being the first — with no way to declare the one method
-- that honestly describes what they do; they fell back to legacy 'api',
-- which only survives via the migration-085 mapping grace window.
--
-- This flag is the analogue of witness_authority: a key with proxy_authority
-- (or an admin key) may write events with source_method='proxied', supplying
-- the public source_feed_url it extracted from. Like the witnessed path, it
-- bypasses api_key_organization_links (the pipeline doesn't own the scraped
-- venue) — but unlike witnessed, the organizer stays the real-world entity
-- whose data was proxied, not a collective.
--
-- Granted at activation (or later) for trusted pipeline keys. The
-- self-service dashboard request flow (cf. migration 087 for witnessing) is
-- intentionally NOT added here — proxy authority is operator-granted to known
-- pipelines for now; add the request column if/when a self-service flow is
-- needed.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS proxy_authority boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN api_keys.proxy_authority IS 'When true, this key can write events with source_method=proxied (docs/four-roles.md Path 2) — attributed to the scraped real-world organizer, carrying the public source_feed_url. Bypasses api_key_organization_links like the witnessed path. Granted to trusted scrape-and-publish pipelines (e.g. Studio).';
