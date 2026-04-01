-- Performance indexes for high-frequency query patterns.

-- Rate limit queries: COUNT(*) WHERE source_method='api' AND source_feed_url=X AND created_at >= X
-- Without this, every Contribute API write does a full table scan twice.
CREATE INDEX IF NOT EXISTS idx_events_source_method_feed
  ON events (source_method, source_feed_url, created_at DESC)
  WHERE source_feed_url IS NOT NULL;

-- Portal accounts by status: WHERE status='active' ORDER BY business_name
CREATE INDEX IF NOT EXISTS idx_portal_accounts_status_name
  ON portal_accounts (status, business_name);
