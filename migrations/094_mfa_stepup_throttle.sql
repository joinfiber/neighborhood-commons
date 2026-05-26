-- Migration 094: per-key MFA step-up throttle + one-time TOTP replay defense.
--
-- POST /developers/security/step-up is the gate guarding self-service API-key
-- rotation and the operator portal. It previously had no per-account attempt
-- limit (only an IP-based form limiter), and a TOTP code was replayable for its
-- full ~90s validity window. These columns back a lockout after repeated
-- failures and let the server reject a TOTP time-step that was already consumed.
-- Idempotent.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS mfa_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS mfa_locked_until timestamptz;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS mfa_last_totp_step bigint;

COMMENT ON COLUMN api_keys.mfa_failed_attempts IS
  'Consecutive failed MFA step-up attempts; reset to 0 on success or when a lockout is applied.';
COMMENT ON COLUMN api_keys.mfa_locked_until IS
  'When set and in the future, MFA step-up is locked out after too many failures.';
COMMENT ON COLUMN api_keys.mfa_last_totp_step IS
  'Highest TOTP time-step already consumed in a successful step-up; codes at or below this are rejected as replays.';
