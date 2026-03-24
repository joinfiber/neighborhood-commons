/** Portal event categories — mirrors src/lib/categories.ts for the portal SPA */
export const PORTAL_CATEGORIES = {
  // Performance
  live_music:    { label: 'Live Music',       slug: 'live-music' },
  dj_dance:      { label: 'DJ & Dance',       slug: 'dj-dance' },
  comedy:        { label: 'Comedy',            slug: 'comedy' },
  theatre:       { label: 'Theatre',           slug: 'theatre' },
  open_mic:      { label: 'Open Mic',          slug: 'open-mic' },
  karaoke:       { label: 'Karaoke',           slug: 'karaoke' },
  // Arts & Culture
  art_exhibit:   { label: 'Art & Exhibits',    slug: 'art-exhibit' },
  film:          { label: 'Film',              slug: 'film' },
  literary:      { label: 'Literary',          slug: 'literary' },
  tour:          { label: 'Tour',              slug: 'tour' },
  // Food & Drink
  happy_hour:    { label: 'Happy Hour',        slug: 'happy-hour' },
  market:        { label: 'Market & Pop-up',   slug: 'market' },
  // Active
  fitness:       { label: 'Fitness',           slug: 'fitness' },
  sports:        { label: 'Sports & Rec',      slug: 'sports' },
  outdoors:      { label: 'Outdoors & Nature', slug: 'outdoors' },
  // Learning & Social
  class:         { label: 'Class & Workshop',  slug: 'class' },
  trivia_games:  { label: 'Trivia & Games',    slug: 'trivia-games' },
  kids_family:   { label: 'Kids & Family',     slug: 'kids-family' },
  // Civic
  community:     { label: 'Community',         slug: 'community' },
  spectator:     { label: 'Spectator',         slug: 'spectator' },
} as const;

export type PortalCategory = keyof typeof PORTAL_CATEGORIES;

export const PORTAL_CATEGORY_KEYS = Object.keys(PORTAL_CATEGORIES) as PortalCategory[];
