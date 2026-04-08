-- 050: Category Proposals
-- Contributors can propose new categories when the existing 20 don't fit.
-- Proposals are stored for admin review. The event itself gets created with
-- the fallback_category and custom_category fields.

CREATE TABLE IF NOT EXISTS category_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_name text NOT NULL,
  justification text,
  fallback_category text NOT NULL,
  contributor_account_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES contribution_batches(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE category_proposals ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE category_proposals IS
  'Contributor-proposed categories for admin review. Enables collective ownership of the taxonomy.';

-- RPC: Popular tags — usage counts for tag alignment in the contributor portal
CREATE OR REPLACE FUNCTION get_popular_tags(since timestamptz)
RETURNS TABLE(tag text, count bigint)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT unnest(tags) AS tag, count(*) AS count
  FROM events
  WHERE status = 'published'
    AND event_at > since
    AND array_length(tags, 1) > 0
  GROUP BY tag
  ORDER BY count DESC
  LIMIT 50;
$$;

-- Grant to service role only (called from Express via supabaseAdmin)
REVOKE EXECUTE ON FUNCTION get_popular_tags(timestamptz) FROM PUBLIC, authenticated, anon;
