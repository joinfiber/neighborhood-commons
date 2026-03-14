-- Add optional RSVP limit to events
-- NULL means no limit; positive integer means max attendees

ALTER TABLE events ADD COLUMN IF NOT EXISTS rsvp_limit integer;
