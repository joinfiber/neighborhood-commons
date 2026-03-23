-- Add operating hours to portal accounts
-- Structured JSONB: array of 7 day objects (Mon-Sun), each with open/closed + time ranges
-- Example: [{"open":true,"ranges":[{"start":"11:00","end":"02:00"}]},{"open":false,"ranges":[]},...]
-- This column will eventually migrate to the groups table (Phase 2).

ALTER TABLE portal_accounts
ADD COLUMN IF NOT EXISTS operating_hours JSONB DEFAULT NULL;

COMMENT ON COLUMN portal_accounts.operating_hours IS
  'Structured weekly hours: 7-element array [Mon..Sun], each {open: bool, ranges: [{start, end}]}';
