/**
 * Event Tag Taxonomy — Portal Frontend
 *
 * Mirrors src/lib/tags.ts for the portal SPA.
 * Tags describe the experience of attending, not the content.
 */

import type { PortalCategory } from './categories';

export const EVENT_TAGS = {
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
  'registration-required': { label: 'Registration Required', group: 'logistics' },
  'drop-in':           { label: 'Drop-In',              group: 'logistics' },
  'limited-spots':     { label: 'Limited Spots',        group: 'logistics' },
  'solo-friendly':     { label: 'Solo-Friendly',        group: 'logistics' },
  'bring-gear':        { label: 'Bring Gear',           group: 'logistics' },
  'outdoor':           { label: 'Outdoor',              group: 'setting' },
  'rooftop':           { label: 'Rooftop',              group: 'setting' },
  'seated':            { label: 'Seated',               group: 'setting' },
  'chill':             { label: 'Chill',                 group: 'vibe' },
  'high-energy':       { label: 'High-Energy',          group: 'vibe' },
  'late-night':        { label: 'Late-Night',           group: 'vibe' },
  'beginner-friendly': { label: 'Beginner-Friendly',    group: 'vibe' },
  'themed':            { label: 'Themed',               group: 'vibe' },
  'competitive':       { label: 'Competitive',          group: 'vibe' },
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

export const CATEGORY_TAGS: Record<PortalCategory, EventTag[]> = {
  // Performance
  live_music:      ['outdoor', 'rooftop', 'all-ages', '21-plus', 'free', 'cover-charge', 'cash-only', 'seated', 'acoustic', 'chill', 'high-energy', 'late-night', 'byob', 'solo-friendly'],
  dj_dance:        ['outdoor', 'rooftop', '18-plus', '21-plus', 'free', 'cover-charge', 'cash-only', 'late-night', 'high-energy', 'themed', 'na-friendly', 'byob'],
  comedy:          ['all-ages', '21-plus', 'free', 'cover-charge', 'cash-only', 'seated', 'late-night', 'byob', 'themed'],
  karaoke:         ['all-ages', '21-plus', 'free', 'late-night', 'na-friendly', 'byob', 'themed', 'drop-in', 'solo-friendly'],
  open_mic:        ['all-ages', '21-plus', 'free', 'beginner-friendly', 'drop-in', 'registration-required', 'late-night', 'byob', 'outdoor', 'solo-friendly'],
  // Arts & Culture
  art_gallery:     ['free', 'all-ages', 'family-friendly', 'outdoor', 'drop-in', 'hands-on', 'na-friendly', 'dog-friendly'],
  film_screening:  ['outdoor', 'free', 'all-ages', 'family-friendly', 'seated', 'na-friendly', 'dog-friendly', 'limited-spots', 'themed', 'late-night'],
  theatre:         ['all-ages', '21-plus', 'free', 'cover-charge', 'seated', 'late-night', 'themed', 'limited-spots', 'cash-only'],
  // Food & Drink
  happy_hour:      ['outdoor', 'rooftop', 'na-friendly', 'free', 'cash-only', 'dog-friendly', 'chill', 'byob'],
  food_drink:      ['outdoor', 'na-friendly', 'free', 'cash-only', 'family-friendly', 'all-ages', 'byob', 'dog-friendly', 'chill', 'tasting'],
  market_popup:    ['outdoor', 'free', 'cash-only', 'family-friendly', 'all-ages', 'dog-friendly'],
  // Active
  fitness_class:   ['outdoor', 'free', 'donation-based', 'all-ages', 'beginner-friendly', 'registration-required', 'drop-in', 'limited-spots', 'bring-gear', 'solo-friendly', 'high-energy', 'chill'],
  sports_rec:      ['outdoor', 'free', 'all-ages', 'family-friendly', 'participatory', 'beginner-friendly', 'drop-in', 'registration-required', 'dog-friendly', 'solo-friendly', 'competitive', 'bring-gear'],
  // Learning & Social
  workshop_class:  ['free', 'donation-based', 'all-ages', 'family-friendly', 'beginner-friendly', 'registration-required', 'drop-in', 'hands-on', 'outdoor', 'limited-spots', 'solo-friendly'],
  trivia_games:    ['all-ages', '21-plus', 'free', 'themed', 'na-friendly', 'byob', 'dog-friendly', 'outdoor', 'solo-friendly', 'competitive'],
  // General
  community:       ['outdoor', 'free', 'family-friendly', 'all-ages', 'dog-friendly', 'participatory', 'drop-in', 'volunteer', 'beginner-friendly', 'solo-friendly'],
  spectator:       ['outdoor', 'all-ages', 'family-friendly', '21-plus', 'free', 'cover-charge', 'seated', 'high-energy', 'themed', 'cash-only', 'na-friendly', 'dog-friendly'],
  other:           ALL_TAG_SLUGS as unknown as EventTag[],
};

/** Get the curated tags for a category, filtering out tags not in the new list when switching */
export function getTagsForCategory(category: string): EventTag[] {
  return CATEGORY_TAGS[category as PortalCategory] || ALL_TAG_SLUGS;
}
