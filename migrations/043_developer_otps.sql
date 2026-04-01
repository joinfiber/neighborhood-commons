-- Developer OTP verification — decoupled from Supabase Auth.
-- Supabase Auth is for Merrie user sessions (magic links).
-- This table is for developer API key registration (numeric codes).

CREATE TABLE IF NOT EXISTS developer_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Index for lookup by email
CREATE INDEX IF NOT EXISTS idx_developer_otps_email ON developer_otps (email);

-- Auto-cleanup: expired OTPs are worthless
CREATE INDEX IF NOT EXISTS idx_developer_otps_expires ON developer_otps (expires_at);

-- RLS: deny all non-service access
ALTER TABLE developer_otps ENABLE ROW LEVEL SECURITY;
