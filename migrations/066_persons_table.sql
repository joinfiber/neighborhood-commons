-- ============================================================================
-- Migration 066: persons table
--
-- Schema.org Person. Used for individuals — DJs, performers, curators,
-- individual organizers. Light verification (control of email).
--
-- Pure create. Empty initially. Apps populate as they need to model
-- individuals (e.g., events with a Person organizer, performers in event
-- lineups, lists curated by a person). Apps that don't model individuals
-- can keep using freeform performer strings; persons is opt-in.
-- ============================================================================

CREATE TABLE IF NOT EXISTS persons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text UNIQUE NOT NULL,
  name              text NOT NULL,
  given_name        text,
  family_name       text,
  alternate_name    text,
  description       text,
  image_url         text,
  url               text,
  same_as           jsonb DEFAULT '[]'::jsonb,
  job_title         text,
  owner_account_id  uuid REFERENCES portal_accounts(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_persons_owner ON persons(owner_account_id);

DROP TRIGGER IF EXISTS persons_updated_at ON persons;
CREATE TRIGGER persons_updated_at
  BEFORE UPDATE ON persons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE persons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS persons_public_read ON persons;
CREATE POLICY persons_public_read
  ON persons FOR SELECT
  TO anon, authenticated
  USING (true);

COMMENT ON TABLE persons IS 'Schema.org Person. Individuals — performers, curators, organizers. Light-rigor verification (email loop, any domain).';
COMMENT ON COLUMN persons.alternate_name IS 'Stage names, aliases, handles. e.g. "DJ Karma" for someone whose given name is Karen.';
COMMENT ON COLUMN persons.same_as IS 'JSONB array of canonical URLs (Wikipedia, Wikidata, SoundCloud, etc.).';
