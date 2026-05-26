-- Migration 095: publisher_org_ids() — distinct org ids that have published.
--
-- GET /v1/publishers previously loaded EVERY published event's organizer_org_id
-- (and every active broadcast's organization_id) into the Node process on every
-- request, then deduped into a Set in app memory — an O(events) scan-and-transfer
-- per request that degrades linearly as the events table grows. This RPC dedups
-- in Postgres and returns only the distinct publisher org ids. The detail route
-- (/publishers/:idOrSlug) no longer materializes the set at all; it uses two
-- indexed existence checks (see routes/v1-publishers.ts::isPublisherOrg).
--
-- STABLE, SECURITY DEFINER, service-role only. Idempotent.

CREATE OR REPLACE FUNCTION publisher_org_ids()
RETURNS TABLE(org_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT DISTINCT organizer_org_id
    FROM events
   WHERE status = 'published' AND organizer_org_id IS NOT NULL
  UNION
  SELECT DISTINCT organization_id
    FROM broadcasts
   WHERE status = 'active' AND organization_id IS NOT NULL
$$;

REVOKE EXECUTE ON FUNCTION publisher_org_ids() FROM PUBLIC, authenticated, anon;
