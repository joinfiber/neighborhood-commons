-- Fix the regions table timezone default from America/Los_Angeles to America/New_York.
-- The original default was a placeholder; this project operates in Philadelphia.

ALTER TABLE regions ALTER COLUMN timezone SET DEFAULT 'America/New_York';

-- Update any existing regions that still have the old default
UPDATE regions SET timezone = 'America/New_York' WHERE timezone = 'America/Los_Angeles';
