-- Migration 097: GIN index on webhook_subscriptions.event_types.
--
-- The webhook dispatchers now filter active subscriptions by event type in SQL
-- (event_types @> ARRAY[type]) instead of loading up to 10000 active rows and
-- filtering in JS on every event mutation. This GIN index turns that containment
-- check into an index scan. Idempotent.

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_event_types
  ON webhook_subscriptions USING GIN (event_types);
