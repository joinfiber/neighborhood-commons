-- Migration 035: Suspend/reactivate RPC functions
-- Atomic account suspension and reactivation with event status cascading.
-- Both functions are SECURITY DEFINER (service role only) to prevent
-- direct invocation by authenticated/anon roles.

-- =============================================================================
-- suspend_portal_account
-- =============================================================================
-- Suspends an active account and all its published events in one transaction.
-- Returns the count of events suspended.

CREATE OR REPLACE FUNCTION suspend_portal_account(p_account_id UUID)
RETURNS TABLE(events_suspended BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- Set account status to suspended
  UPDATE portal_accounts
  SET status = 'suspended', updated_at = now()
  WHERE id = p_account_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % is not active or does not exist', p_account_id;
  END IF;

  -- Suspend all published events owned by this account
  WITH suspended AS (
    UPDATE events
    SET status = 'suspended'
    WHERE creator_account_id = p_account_id
      AND status = 'published'
    RETURNING id
  )
  SELECT count(*) INTO events_suspended FROM suspended;

  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION suspend_portal_account(UUID) FROM PUBLIC, authenticated, anon;

-- =============================================================================
-- reactivate_portal_account
-- =============================================================================
-- Reactivates a suspended account and republishes its suspended events.
-- Returns the count of events reactivated.

CREATE OR REPLACE FUNCTION reactivate_portal_account(p_account_id UUID)
RETURNS TABLE(events_reactivated BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- Set account status back to active
  UPDATE portal_accounts
  SET status = 'active', updated_at = now()
  WHERE id = p_account_id AND status = 'suspended';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % is not suspended or does not exist', p_account_id;
  END IF;

  -- Republish all suspended events owned by this account
  WITH reactivated AS (
    UPDATE events
    SET status = 'published'
    WHERE creator_account_id = p_account_id
      AND status = 'suspended'
    RETURNING id
  )
  SELECT count(*) INTO events_reactivated FROM reactivated;

  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION reactivate_portal_account(UUID) FROM PUBLIC, authenticated, anon;
