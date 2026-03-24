/**
 * Event Tag Taxonomy
 *
 * 30 experience/setting/access tags drawn from a shared pool, curated per category.
 * Tags describe the experience of attending, not the content — "outdoor" and "all-ages"
 * help someone decide whether to go. Genre and topic live in descriptions and search.
 *
 * Stored in code, not DB, so the pool can evolve without migrations.
 * The DB stores whatever slugs are on the event; validation happens here.
 */

import type { EventCategory } from './categories.js';

// =============================================================================
// TAG POOL — 30 tags across 6 dimensions
// =============================================================================

export const EVENT_TAGS = {
  // Access — "Can I go?"
  'all-ages':          { label: 'All Ages',             group: 'access' },
  '18-plus':           { label: '18+',                  group: 'access' },
  '21-plus':           { label: '21+',                  group: 'access' },
  'family-friendly':   { label: 'Family-Friendly',      group: 'access' },
  'free':              { label: 'Free',                  group: 'access' },
  'cover-charge':      { label: 'Cover Charge',         group: 'access' },
  'donation-based':    { label: 'Donation-Based',       group: 'access' },
  'na-friendly':       { label: 'N/A Friendly',         group: 'access' },
  'byob':              { label: 'BYOB',                 group: 'access' },
  'dog-friendly':      { label: 'Dog-Friendly',         group: 'access' },
  'cash-only':         { label: 'Cash Only',            group: 'access' },

  // Logistics — "How do I attend?"
  'registration-required': { label: 'Registration Required', group: 'logistics' },
  'drop-in':           { label: 'Drop-In',              group: 'logistics' },
  'limited-spots':     { label: 'Limited Spots',        group: 'logistics' },
  'solo-friendly':     { label: 'Solo-Friendly',        group: 'logistics' },
  'bring-gear':        { label: 'Bring Gear',           group: 'logistics' },

  // Setting — "What's the space like?"
  'outdoor':           { label: 'Outdoor',              group: 'setting' },
  'rooftop':           { label: 'Rooftop',              group: 'setting' },
  'seated':            { label: 'Seated',               group: 'setting' },

  // Vibe — "What's the energy?"
  'chill':             { label: 'Chill',                 group: 'vibe' },
  'high-energy':       { label: 'High-Energy',          group: 'vibe' },
  'late-night':        { label: 'Late-Night',           group: 'vibe' },
  'beginner-friendly': { label: 'Beginner-Friendly',    group: 'vibe' },
  'themed':            { label: 'Themed',               group: 'vibe' },
  'competitive':       { label: 'Competitive',          group: 'vibe' },

  // Format — "What happens there?"
  'hands-on':          { label: 'Hands-On',             group: 'format' },
  'tasting':           { label: 'Tasting',              group: 'format' },
  'acoustic':          { label: 'Acoustic',             group: 'format' },
  'participatory':     { label: 'Participatory',        group: 'format' },
  'volunteer':         { label: 'Volunteer',            group: 'format' },
} as const;

export type EventTag = keyof typeof EVENT_TAGS;

export const ALL_TAG_SLUGS = Object.keys(EVENT_TAGS) as EventTag[];

/** Age tags are mutually exclusive — pick one or none */
export const AGE_TAGS: EventTag[] = ['all-ages', '18-plus', '21-plus'];

// =============================================================================
// PER-CATEGORY TAG CURATION
// =============================================================================

export const CATEGORY_TAGS: Record<EventCategory, EventTag[]> = {
  // Performance
  live_music:    ['outdoor', 'rooftop', 'all-ages', '21-plus', 'free', 'cover-charge', 'cash-only', 'seated', 'acoustic', 'chill', 'high-energy', 'late-night', 'byob', 'solo-friendly'],
  dj_dance:      ['outdoor', 'rooftop', '18-plus', '21-plus', 'free', 'cover-charge', 'cash-only', 'late-night', 'high-energy', 'themed', 'na-friendly', 'byob'],
  comedy:        ['all-ages', '21-plus', 'free', 'cover-charge', 'cash-only', 'seated', 'late-night', 'byob', 'themed'],
  theatre:       ['all-ages', '21-plus', 'free', 'cover-charge', 'seated', 'late-night', 'themed', 'limited-spots', 'cash-only'],
  open_mic:      ['all-ages', '21-plus', 'free', 'beginner-friendly', 'drop-in', 'registration-required', 'late-night', 'byob', 'outdoor', 'solo-friendly'],
  karaoke:       ['all-ages', '21-plus', 'free', 'late-night', 'na-friendly', 'byob', 'themed', 'drop-in', 'solo-friendly'],

  // Arts & Culture
  art_exhibit:   ['free', 'all-ages', 'family-friendly', 'outdoor', 'drop-in', 'hands-on', 'na-friendly', 'dog-friendly'],
  film:          ['outdoor', 'free', 'all-ages', 'family-friendly', 'seated', 'na-friendly', 'dog-friendly', 'limited-spots', 'themed', 'late-night'],
  literary:      ['free', 'all-ages', 'family-friendly', 'seated', 'na-friendly', 'drop-in', 'solo-friendly', 'beginner-friendly'],
  tour:          ['free', 'all-ages', 'family-friendly', 'outdoor', 'dog-friendly', 'registration-required', 'limited-spots', 'beginner-friendly', 'tasting'],

  // Food & Drink
  happy_hour:    ['outdoor', 'rooftop', 'na-friendly', 'free', 'cash-only', 'dog-friendly', 'chill', 'byob'],
  market:        ['outdoor', 'free', 'cash-only', 'family-friendly', 'all-ages', 'dog-friendly'],

  // Active
  fitness:       ['outdoor', 'free', 'donation-based', 'all-ages', 'beginner-friendly', 'registration-required', 'drop-in', 'limited-spots', 'bring-gear', 'solo-friendly', 'high-energy', 'chill'],
  sports:        ['outdoor', 'free', 'all-ages', 'family-friendly', 'participatory', 'beginner-friendly', 'drop-in', 'registration-required', 'dog-friendly', 'solo-friendly', 'competitive', 'bring-gear'],
  outdoors:      ['free', 'all-ages', 'family-friendly', 'outdoor', 'dog-friendly', 'beginner-friendly', 'drop-in', 'registration-required', 'bring-gear', 'volunteer', 'solo-friendly'],

  // Learning & Social
  class:         ['free', 'donation-based', 'all-ages', 'family-friendly', 'beginner-friendly', 'registration-required', 'drop-in', 'hands-on', 'outdoor', 'limited-spots', 'solo-friendly'],
  trivia_games:  ['all-ages', '21-plus', 'free', 'themed', 'na-friendly', 'byob', 'dog-friendly', 'outdoor', 'solo-friendly', 'competitive'],
  kids_family:   ['free', 'all-ages', 'family-friendly', 'outdoor', 'drop-in', 'registration-required', 'hands-on', 'beginner-friendly', 'dog-friendly'],

  // Civic
  community:     ['outdoor', 'free', 'family-friendly', 'all-ages', 'dog-friendly', 'participatory', 'drop-in', 'volunteer', 'beginner-friendly', 'solo-friendly'],
  spectator:     ['outdoor', 'all-ages', 'family-friendly', '21-plus', 'free', 'cover-charge', 'seated', 'high-energy', 'themed', 'cash-only', 'na-friendly', 'dog-friendly'],
};

/**
 * Validate tags for a given category.
 * Returns the subset of tags that are valid for the category.
 * Enforces age-tag mutual exclusivity.
 */
export function validateTags(tags: string[], category: string): string[] {
  const allowed = CATEGORY_TAGS[category as EventCategory] || ALL_TAG_SLUGS;
  const valid = tags.filter(t => allowed.includes(t as EventTag));

  // Enforce age-tag mutual exclusivity: keep only the first age tag
  const ageTags = valid.filter(t => AGE_TAGS.includes(t as EventTag));
  if (ageTags.length > 1) {
    const keep = ageTags[0]!;
    return valid.filter(t => !AGE_TAGS.includes(t as EventTag) || t === keep);
  }

  return valid;
}
