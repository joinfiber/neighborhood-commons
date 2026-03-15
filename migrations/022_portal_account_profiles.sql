-- Portal account profiles: slug, bio for public venue pages.
-- Slugs enable URLs like /venues/the-jazz-spot

ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS slug text UNIQUE;

-- bio and website_url already exist on portal_accounts (migration 001).
-- logo_url already exists on portal_accounts (migration 001).
-- This migration only adds the slug column.

-- Generate initial slugs from existing business_name values.
-- Format: lowercase, non-alphanumeric → hyphens, collapse runs, trim edges.
-- Conflicts get a numeric suffix.
UPDATE portal_accounts
SET slug = sub.slug
FROM (
  SELECT
    id,
    CASE
      WHEN cnt > 1 THEN base || '-' || rn
      ELSE base
    END AS slug
  FROM (
    SELECT
      id,
      LOWER(
        TRIM(BOTH '-' FROM
          REGEXP_REPLACE(
            REGEXP_REPLACE(LOWER(business_name), '[^a-z0-9]+', '-', 'g'),
            '-+', '-', 'g'
          )
        )
      ) AS base,
      ROW_NUMBER() OVER (
        PARTITION BY LOWER(
          TRIM(BOTH '-' FROM
            REGEXP_REPLACE(
              REGEXP_REPLACE(LOWER(business_name), '[^a-z0-9]+', '-', 'g'),
              '-+', '-', 'g'
            )
          )
        )
        ORDER BY created_at
      ) AS rn,
      COUNT(*) OVER (
        PARTITION BY LOWER(
          TRIM(BOTH '-' FROM
            REGEXP_REPLACE(
              REGEXP_REPLACE(LOWER(business_name), '[^a-z0-9]+', '-', 'g'),
              '-+', '-', 'g'
            )
          )
        )
      ) AS cnt
    FROM portal_accounts
    WHERE slug IS NULL AND business_name IS NOT NULL
  ) ranked
) sub
WHERE portal_accounts.id = sub.id;
