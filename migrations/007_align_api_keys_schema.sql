-- ============================================================================
-- Migration 007: Align api_keys schema with application code
-- ============================================================================
-- The api_keys table was updated in production to store hashed keys instead
-- of plaintext, rename columns, and use status strings instead of booleans.
-- This migration formalizes those changes so migration files match reality.
--
-- Safe to run on a DB that already has these changes (IF EXISTS / IF NOT EXISTS).

-- --------------------------------------------------------------------------
-- Add new columns (no-ops if already present)
-- --------------------------------------------------------------------------

-- SHA-256 hash of the raw key (plaintext is never stored)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash text;

-- First 12 chars of the raw key for display/identification
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix text;

-- Contact email replaces owner_email
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS contact_email text;

-- Status string replaces is_active boolean
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Track last usage
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

-- --------------------------------------------------------------------------
-- Migrate data from old columns to new ones (if old columns still exist)
-- --------------------------------------------------------------------------

-- If key (plaintext) exists, hash it into key_hash and extract prefix
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'key'
  ) THEN
    UPDATE api_keys
    SET key_hash = encode(sha256(key::bytea), 'hex'),
        key_prefix = substring(key FROM 1 FOR 12)
    WHERE key IS NOT NULL AND key_hash IS NULL;
  END IF;
END $$;

-- Copy owner_email to contact_email if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'owner_email'
  ) THEN
    UPDATE api_keys
    SET contact_email = owner_email
    WHERE owner_email IS NOT NULL AND contact_email IS NULL;
  END IF;
END $$;

-- Convert is_active boolean to status string if is_active exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'is_active'
  ) THEN
    UPDATE api_keys
    SET status = CASE WHEN is_active = true THEN 'active' ELSE 'revoked' END
    WHERE status = 'active' AND is_active = false;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Drop old columns (safe if already dropped)
-- --------------------------------------------------------------------------

ALTER TABLE api_keys DROP COLUMN IF EXISTS key;
ALTER TABLE api_keys DROP COLUMN IF EXISTS owner_email;
ALTER TABLE api_keys DROP COLUMN IF EXISTS is_active;

-- --------------------------------------------------------------------------
-- Indexes
-- --------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_contact_email ON api_keys(contact_email);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
