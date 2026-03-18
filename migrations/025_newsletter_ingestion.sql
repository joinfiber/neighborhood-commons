-- Newsletter event ingestion pipeline: sources, emails, and extracted candidates.
-- Enables ingesting events from email newsletters via LLM extraction
-- with admin review before publishing to the commons.

-- Newsletter sources: newsletters we're subscribed to
CREATE TABLE IF NOT EXISTS newsletter_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sender_email text,
  notes text,
  auto_approve boolean DEFAULT false,
  status text DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_at timestamptz DEFAULT now(),
  last_received_at timestamptz
);

ALTER TABLE newsletter_sources ENABLE ROW LEVEL SECURITY;
-- No policies: default deny for anon/authenticated. supabaseAdmin (service_role) bypasses RLS.

-- Raw inbound emails from Mailgun
CREATE TABLE IF NOT EXISTS newsletter_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES newsletter_sources(id),
  message_id text,
  sender_email text NOT NULL,
  subject text NOT NULL,
  body_html text,
  body_plain text,
  received_at timestamptz DEFAULT now(),
  processing_status text DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  processing_error text,
  candidate_count int,
  llm_response text
);

ALTER TABLE newsletter_emails ENABLE ROW LEVEL SECURITY;

-- Unique on message_id for idempotent Mailgun delivery (nulls excluded)
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_emails_message_id_uniq
  ON newsletter_emails(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS newsletter_emails_source_id_idx ON newsletter_emails(source_id);
CREATE INDEX IF NOT EXISTS newsletter_emails_processing_status_idx ON newsletter_emails(processing_status);

-- LLM-extracted event candidates awaiting admin review
CREATE TABLE IF NOT EXISTS event_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid REFERENCES newsletter_emails(id) NOT NULL,
  source_id uuid REFERENCES newsletter_sources(id),
  title text NOT NULL,
  description text,
  start_date date,
  start_time time,
  end_time time,
  location_name text,
  location_address text,
  location_lat double precision,
  location_lng double precision,
  source_url text,
  confidence numeric(3,2),
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'duplicate')),
  matched_event_id uuid,
  match_confidence numeric(3,2),
  review_notes text,
  created_at timestamptz DEFAULT now(),
  reviewed_at timestamptz
);

ALTER TABLE event_candidates ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS event_candidates_email_id_idx ON event_candidates(email_id);
CREATE INDEX IF NOT EXISTS event_candidates_status_idx ON event_candidates(status);
CREATE INDEX IF NOT EXISTS event_candidates_matched_event_id_idx ON event_candidates(matched_event_id);

-- Expand events.source constraint to allow 'newsletter'
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_source_check;
ALTER TABLE events ADD CONSTRAINT events_source_check
  CHECK (source IN ('portal', 'admin', 'import', 'api', 'newsletter'));
