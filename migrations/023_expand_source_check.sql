-- Expand the events.source check constraint to include 'import' and 'api'.
-- Phase 1 added import (iCal/Eventbrite) and contribute (write API) sources,
-- but the original CHECK only allowed 'portal' and 'admin'.

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_source_check;
ALTER TABLE events ADD CONSTRAINT events_source_check
  CHECK (source IN ('portal', 'admin', 'import', 'api'));
