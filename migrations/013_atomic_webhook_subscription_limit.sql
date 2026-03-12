-- ============================================================================
-- Migration 013: Atomic webhook subscription limit
-- ============================================================================
-- The webhook subscription creation route previously did SELECT count + INSERT
-- as two separate operations. Under concurrent requests, both could pass the
-- count check and insert, exceeding the per-key limit.
--
-- This RPC function uses an advisory lock keyed on the api_key_id to serialize
-- subscription creation per key, making the count + insert atomic.

CREATE OR REPLACE FUNCTION create_webhook_subscription(
  p_api_key_id UUID,
  p_url TEXT,
  p_event_types TEXT[],
  p_signing_secret TEXT,
  p_signing_secret_encrypted BYTEA DEFAULT NULL,
  p_max_subscriptions INT DEFAULT 5
)
RETURNS webhook_subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  current_count INT;
  result webhook_subscriptions%ROWTYPE;
BEGIN
  -- Advisory lock serializes concurrent creates for the same api_key_id
  PERFORM pg_advisory_xact_lock(hashtext(p_api_key_id::text));

  SELECT COUNT(*) INTO current_count
  FROM webhook_subscriptions
  WHERE api_key_id = p_api_key_id;

  IF current_count >= p_max_subscriptions THEN
    RAISE EXCEPTION 'Subscription limit reached (% per key)', p_max_subscriptions
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO webhook_subscriptions (api_key_id, url, event_types, signing_secret, signing_secret_encrypted)
  VALUES (p_api_key_id, p_url, p_event_types, p_signing_secret, p_signing_secret_encrypted)
  RETURNING * INTO result;

  RETURN result;
END;
$$;

-- Restrict access: only service_role (via supabaseAdmin) can call this
REVOKE EXECUTE ON FUNCTION create_webhook_subscription FROM PUBLIC, authenticated, anon;
