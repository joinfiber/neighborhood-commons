/**
 * Event Categories — Neighborhood Commons
 *
 * 20 categories organized by activity posture. Designed for consumer browsing
 * (Fiber, Merrie) and LLM classification. Only categories with events show
 * in consumer apps — it's fine to have categories with no current events.
 *
 * Taxonomy informed by Eventbrite (21 cats), Meetup (20), JoinPhilly (21),
 * Facebook (22), and Schema.org event types. See CLAUDE.md for rationale.
 */

export const EVENT_CATEGORIES = {
  // Performance — you go to watch or listen
  live_music:    { label: 'Live Music',       color: '#E85D3A' },
  dj_dance:      { label: 'DJ & Dance',       color: '#A855F7' },
  comedy:        { label: 'Comedy',            color: '#F59E0B' },
  theatre:       { label: 'Theatre',           color: '#D946EF' },
  open_mic:      { label: 'Open Mic',          color: '#8B5CF6' },
  karaoke:       { label: 'Karaoke',           color: '#EC4899' },

  // Arts & Culture — you go to experience or see
  art_exhibit:   { label: 'Art & Exhibits',    color: '#B47AEA' },
  film:          { label: 'Film',              color: '#EF4444' },
  literary:      { label: 'Literary',          color: '#78716C' },
  tour:          { label: 'Tour',              color: '#0891B2' },

  // Food & Drink
  happy_hour:    { label: 'Happy Hour',        color: '#F59E0B' },
  market:        { label: 'Market & Pop-up',   color: '#14B8A6' },

  // Active
  fitness:       { label: 'Fitness',           color: '#10B981' },
  sports:        { label: 'Sports & Rec',      color: '#3B82F6' },
  outdoors:      { label: 'Outdoors & Nature', color: '#16A34A' },

  // Learning & Social
  class:         { label: 'Class & Workshop',  color: '#F97316' },
  trivia_games:  { label: 'Trivia & Games',    color: '#6366F1' },
  kids_family:   { label: 'Kids & Family',     color: '#F472B6' },

  // Civic
  community:     { label: 'Community',         color: '#22C55E' },
  spectator:     { label: 'Spectator',         color: '#0EA5E9' },
} as const;

export type EventCategory = keyof typeof EVENT_CATEGORIES;

export const EVENT_CATEGORY_KEYS = Object.keys(EVENT_CATEGORIES) as EventCategory[];
