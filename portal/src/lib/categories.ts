/** Portal event categories — inlined to avoid workspace dependency on @fiber/config */
export const PORTAL_CATEGORIES = {
  live_music:      { label: 'Live Music',       slug: 'live-music' },
  dj_dance:        { label: 'DJ / Dance',       slug: 'dj-dance' },
  comedy:          { label: 'Comedy',            slug: 'comedy' },
  trivia:          { label: 'Trivia',            slug: 'trivia' },
  karaoke:         { label: 'Karaoke',           slug: 'karaoke' },
  open_mic:        { label: 'Open Mic',          slug: 'open-mic' },
  art_gallery:     { label: 'Art / Gallery',     slug: 'art-gallery' },
  workshop_class:  { label: 'Workshop / Class',  slug: 'workshop-class' },
  happy_hour:      { label: 'Happy Hour',        slug: 'happy-hour' },
  food_drink:      { label: 'Food & Drink',      slug: 'food-drink' },
  market_popup:    { label: 'Market / Pop-up',   slug: 'market-popup' },
  community:       { label: 'Community',          slug: 'community' },
  sports:          { label: 'Sports',             slug: 'sports' },
  other:           { label: 'Other',              slug: 'other' },
} as const;

export type PortalCategory = keyof typeof PORTAL_CATEGORIES;

export const PORTAL_CATEGORY_KEYS = Object.keys(PORTAL_CATEGORIES) as PortalCategory[];
