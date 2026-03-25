/** Portal event categories — mirrors src/lib/categories.ts for the portal SPA */
export const PORTAL_CATEGORIES = {
  // Performance
  live_music:    { label: 'Live Music',       slug: 'live-music',    color: '#E85D3A' },
  dj_dance:      { label: 'DJ & Dance',       slug: 'dj-dance',     color: '#A855F7' },
  comedy:        { label: 'Comedy',            slug: 'comedy',       color: '#F59E0B' },
  theatre:       { label: 'Theatre',           slug: 'theatre',      color: '#D946EF' },
  open_mic:      { label: 'Open Mic',          slug: 'open-mic',     color: '#8B5CF6' },
  karaoke:       { label: 'Karaoke',           slug: 'karaoke',      color: '#EC4899' },
  // Arts & Culture
  art_exhibit:   { label: 'Art & Exhibits',    slug: 'art-exhibit',  color: '#B47AEA' },
  film:          { label: 'Film',              slug: 'film',         color: '#EF4444' },
  literary:      { label: 'Literary',          slug: 'literary',     color: '#78716C' },
  tour:          { label: 'Tour',              slug: 'tour',         color: '#0891B2' },
  // Food & Drink
  happy_hour:    { label: 'Happy Hour',        slug: 'happy-hour',   color: '#F59E0B' },
  market:        { label: 'Market & Pop-up',   slug: 'market',       color: '#14B8A6' },
  // Active
  fitness:       { label: 'Fitness',           slug: 'fitness',      color: '#10B981' },
  sports:        { label: 'Sports & Rec',      slug: 'sports',       color: '#3B82F6' },
  outdoors:      { label: 'Outdoors & Nature', slug: 'outdoors',     color: '#16A34A' },
  // Learning & Social
  class:         { label: 'Class & Workshop',  slug: 'class',        color: '#F97316' },
  trivia_games:  { label: 'Trivia & Games',    slug: 'trivia-games', color: '#6366F1' },
  kids_family:   { label: 'Kids & Family',     slug: 'kids-family',  color: '#F472B6' },
  // Civic
  community:     { label: 'Community',         slug: 'community',    color: '#22C55E' },
  spectator:     { label: 'Spectator',         slug: 'spectator',    color: '#0EA5E9' },
} as const;

export type PortalCategory = keyof typeof PORTAL_CATEGORIES;

export const PORTAL_CATEGORY_KEYS = Object.keys(PORTAL_CATEGORIES) as PortalCategory[];
