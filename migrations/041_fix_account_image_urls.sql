-- Fix account image URLs that point to the broken event-image route.
-- Old format: .../api/portal/events/account-{uuid}/logo/image
-- New format: .../api/portal/accounts/{uuid}/logo

-- Fix logo URLs
UPDATE portal_accounts
SET logo_url = regexp_replace(
  logo_url,
  '/api/portal/events/account-([0-9a-f-]+)/logo/image$',
  '/api/portal/accounts/\1/logo'
)
WHERE logo_url LIKE '%/api/portal/events/account-%/logo/image';

-- Fix cover image URLs
UPDATE portal_accounts
SET cover_image_url = regexp_replace(
  cover_image_url,
  '/api/portal/events/account-([0-9a-f-]+)/cover/image$',
  '/api/portal/accounts/\1/cover'
)
WHERE cover_image_url LIKE '%/api/portal/events/account-%/cover/image';
