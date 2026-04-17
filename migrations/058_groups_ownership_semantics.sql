-- Migration 058: Enforce ownership semantics on Contribute-API group writes
--
-- Problem: /api/v1/contribute/groups/:id (PATCH), /groups/:id/venues (POST),
-- and /groups/:groupId/venues/:venueId (DELETE) checked only requireApiKey.
-- Any pending-tier key (self-service via email OTP) could rewrite any group's
-- name, website, coords, phone, links, or category_tags, and could add/remove
-- venue links on groups it did not create. `groups` is public-read, so tampered
-- data flowed straight to every downstream consumer.
--
-- Fix (code-level — this migration is doc-only): group writes are now gated
-- through groups.portal_account_id, matching the Contribute ownership doctrine
-- already in place for events (migration 057). Non-service callers must be
-- linked (via api_key_account_links) to the group's owner account to write.
-- Service-tier keys bypass the check. Groups with NULL portal_account_id are
-- writable only by service-tier keys (operator-claimed legacy groups).
--
-- No schema change is required — the portal_account_id column and its index
-- already exist (migration 034). This migration records the new invariant on
-- the column so a future operator reading `\d groups` sees the ownership
-- semantics without having to read the route handlers.
--
-- No backfill. Any group created before this migration that has
-- portal_account_id IS NULL is intentionally left NULL; the owning API key
-- (if any) is not recoverable from existing records without heuristics, and
-- silently assigning ownership would be worse than requiring a service-tier
-- operator to claim them explicitly.

COMMENT ON COLUMN groups.portal_account_id IS
  'Owning portal account. Set on Contribute-API create via the calling key''s linked account (api_key_account_links). Required for PATCH/venue-write access from non-service keys. NULL means operator-owned: only service-tier keys may write. Also set by migration 034 when a group was seeded from a portal account.';
