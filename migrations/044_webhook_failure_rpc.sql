-- ============================================================================
-- Migration 044: Add increment_webhook_failures RPC function
-- ============================================================================
-- Atomically increments consecutive_failures on a webhook subscription.
-- Auto-disables the subscription if failures exceed the threshold.
-- Called by webhook-delivery.ts on each failed delivery attempt.

CREATE OR REPLACE FUNCTION increment_webhook_failures(
  p_subscription_id uuid,
  p_error_message text,
  p_max_failures integer DEFAULT 10
)
RETURNS TABLE (new_count integer, was_disabled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_new_count integer;
  v_was_disabled boolean := false;
BEGIN
  UPDATE webhook_subscriptions
  SET
    consecutive_failures = consecutive_failures + 1,
    last_failure_at = now(),
    last_failure_reason = p_error_message,
    updated_at = now()
  WHERE id = p_subscription_id
  RETURNING consecutive_failures INTO v_new_count;

  -- Auto-disable if threshold exceeded
  IF v_new_count >= p_max_failures THEN
    UPDATE webhook_subscriptions
    SET status = 'disabled', disabled_at = now(), updated_at = now()
    WHERE id = p_subscription_id AND status = 'active';
    v_was_disabled := true;
  END IF;

  RETURN QUERY SELECT v_new_count, v_was_disabled;
END;
$$;

-- Restrict to service role only
REVOKE EXECUTE ON FUNCTION increment_webhook_failures FROM PUBLIC, authenticated, anon;
