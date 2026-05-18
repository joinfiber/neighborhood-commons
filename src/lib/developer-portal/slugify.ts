/**
 * Slug derivation for contributor_profiles.
 *
 * Slug format (enforced by the DB CHECK constraint in migration 086):
 *   ^[a-z0-9][a-z0-9-]{0,99}$
 *
 * That is: lowercase alphanumeric + hyphens, 1-100 chars, must start with
 * an alphanumeric (no leading hyphen). Collisions are resolved by
 * appending `-2`, `-3`, … until the slug is unique against existing
 * contributor_profiles rows. Per docs/onboarding-redesign.md §9.1.
 */

import { supabaseAdmin } from '../supabase.js';

const MAX_SLUG_LENGTH = 100;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * Convert an app name to a candidate slug. Drops non-ASCII, collapses
 * whitespace + non-alphanumeric runs to single hyphens, trims to 100
 * chars, and lowercases. Returns the empty string if no characters
 * survive (caller should reject and prompt for a different name).
 */
export function baseSlug(appName: string): string {
  return appName
    .toLowerCase()
    // Apostrophe variants (straight, curly L+R, high-reversed-9) get
    // stripped rather than hyphenated, so "Merrie's" → "merries", not
    // "merrie-s". U+0027, U+2018, U+2019, U+201B.
    .replace(/['‘’‛`]/g, '')
    // Replace anything not lowercase alnum with a hyphen
    .replace(/[^a-z0-9]+/g, '-')
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Cap at the DB limit
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * Find an unused slug derived from the given app name. If the base slug
 * is already taken, suffix with `-2`, `-3`, etc. until free.
 *
 * Throws if the app name yields an empty base slug (entirely non-ASCII /
 * non-alphanumeric input). The caller should surface that as a validation
 * error and ask the developer to provide an English-friendly name.
 *
 * Race: there's a small window between the SELECT and the INSERT in the
 * caller. The DB's UNIQUE constraint on contributor_profiles.slug is the
 * actual guard; this function reduces collision likelihood but doesn't
 * eliminate it. Caller should handle ON CONFLICT.
 */
export async function deriveUniqueSlug(appName: string): Promise<string> {
  const base = baseSlug(appName);
  if (!base) {
    throw new Error(`Cannot derive a slug from "${appName}". Try a name with English letters and numbers.`);
  }
  if (!SLUG_PATTERN.test(base)) {
    // Belt-and-suspenders — baseSlug should always produce a valid pattern.
    throw new Error(`Derived slug "${base}" does not match the required format.`);
  }

  // Single query for all existing slugs matching the base — avoids N
  // round-trips when the first N suffixes are taken.
  const { data: existing } = await supabaseAdmin
    .from('contributor_profiles')
    .select('slug')
    .or(`slug.eq.${base},slug.like.${base}-%`);

  const taken = new Set((existing || []).map((r) => r.slug as string));

  if (!taken.has(base)) return base;

  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`.slice(0, MAX_SLUG_LENGTH);
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error(`Could not find an unused slug for "${appName}" within 10000 attempts. Try a more distinctive name.`);
}

/** Re-export the format constraint regex for input-validation reuse. */
export const SLUG_FORMAT = SLUG_PATTERN;
