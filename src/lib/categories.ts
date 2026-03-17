/**
 * Event Categories
 *
 * Canonical event category definitions for Neighborhood Commons.
 * Shared by portal, admin, and public API validation.
 */

export const EVENT_CATEGORIES = {
  live_music:      { label: 'Live Music',        color: '#E85D3A' },
  dj_dance:        { label: 'DJ & Dance',        color: '#A855F7' },
  comedy:          { label: 'Comedy',             color: '#F59E0B' },
  trivia:          { label: 'Trivia',             color: '#6366F1' },
  karaoke:         { label: 'Karaoke',            color: '#EC4899' },
  open_mic:        { label: 'Open Mic',           color: '#8B5CF6' },
  art_gallery:     { label: 'Art & Gallery',      color: '#B47AEA' },
  workshop_class:  { label: 'Workshop & Class',   color: '#F97316' },
  happy_hour:      { label: 'Happy Hour',         color: '#F59E0B' },
  food_drink:      { label: 'Food & Drink',       color: '#E8943E' },
  market_popup:    { label: 'Market & Pop-up',    color: '#14B8A6' },
  community:       { label: 'Community',           color: '#22C55E' },
  sports:          { label: 'Sports',              color: '#3B82F6' },
  film_screenings: { label: 'Film & Screenings',   color: '#EF4444' },
  other:           { label: 'Other',               color: '#6B7280' },
} as const;

export type EventCategory = keyof typeof EVENT_CATEGORIES;

export const EVENT_CATEGORY_KEYS = Object.keys(EVENT_CATEGORIES) as EventCategory[];
