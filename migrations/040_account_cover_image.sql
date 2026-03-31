-- Add cover_image_url to portal_accounts
-- A venue's cover photo is a fact about the venue — self-representation,
-- same category as logo_url, address, and operating hours.

ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS cover_image_url text;
