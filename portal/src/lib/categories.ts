/** Portal event categories — mirrors src/lib/categories.ts for the portal SPA */
export const PORTAL_CATEGORIES = {
  // Performance
  live_music:      { label: 'Live Music',       slug: 'live-music' },
  dj_dance:        { label: 'DJ / Dance',       slug: 'dj-dance' },
  comedy:          { label: 'Comedy',            slug: 'comedy' },
  karaoke:         { label: 'Karaoke',           slug: 'karaoke' },
  open_mic:        { label: 'Open Mic',          slug: 'open-mic' },
  // Arts & Culture
  art_gallery:     { label: 'Art / Gallery',     slug: 'art-gallery' },
  film_screening:  { label: 'Film & Screening',  slug: 'film-screening' },
  theatre:         { label: 'Theatre',            slug: 'theatre' },
  // Food & Drink
  happy_hour:      { label: 'Happy Hour',        slug: 'happy-hour' },
  food_drink:      { label: 'Food & Drink',      slug: 'food-drink' },
  market_popup:    { label: 'Market / Pop-up',   slug: 'market-popup' },
  // Active
  fitness_class:   { label: 'Fitness Class',      slug: 'fitness-class' },
  sports_rec:      { label: 'Sports & Rec',       slug: 'sports-rec' },
  // Learning & Social
  workshop_class:  { label: 'Workshop / Class',  slug: 'workshop-class' },
  trivia_games:    { label: 'Trivia & Games',     slug: 'trivia-games' },
  // General
  community:       { label: 'Community',          slug: 'community' },
  spectator:       { label: 'Spectator',          slug: 'spectator' },
  other:           { label: 'Other',              slug: 'other' },
} as const;

export type PortalCategory = keyof typeof PORTAL_CATEGORIES;

export const PORTAL_CATEGORY_KEYS = Object.keys(PORTAL_CATEGORIES) as PortalCategory[];
