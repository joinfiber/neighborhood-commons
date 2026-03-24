-- Migration 036: Category taxonomy v2
--
-- Expands from 18 to 20 categories. Renames 5, adds 4, removes 2.
-- Remaps existing data to new category keys before updating the constraint.

-- Step 0: Drop old constraint so remaps can proceed
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_category_check;

-- Step 1: Remap renamed categories
UPDATE events SET category = 'art_exhibit' WHERE category = 'art_gallery';
UPDATE events SET category = 'film' WHERE category = 'film_screening';
UPDATE events SET category = 'fitness' WHERE category = 'fitness_class';
UPDATE events SET category = 'sports' WHERE category = 'sports_rec';
UPDATE events SET category = 'market' WHERE category = 'market_popup';
UPDATE events SET category = 'class' WHERE category = 'workshop_class';

-- Step 2: Remap removed categories
-- food_drink → happy_hour (closest match; admin can reclassify individual events)
UPDATE events SET category = 'happy_hour' WHERE category = 'food_drink';
-- other → community (catch-all; admin can reclassify)
UPDATE events SET category = 'community' WHERE category = 'other';

-- Step 3: Remap candidates too
UPDATE event_candidates SET category = 'art_exhibit' WHERE category = 'art_gallery';
UPDATE event_candidates SET category = 'film' WHERE category = 'film_screening';
UPDATE event_candidates SET category = 'fitness' WHERE category = 'fitness_class';
UPDATE event_candidates SET category = 'sports' WHERE category = 'sports_rec';
UPDATE event_candidates SET category = 'market' WHERE category = 'market_popup';
UPDATE event_candidates SET category = 'class' WHERE category = 'workshop_class';
UPDATE event_candidates SET category = 'happy_hour' WHERE category = 'food_drink';
UPDATE event_candidates SET category = 'community' WHERE category = 'other';

-- Step 4: Catch-all for any unexpected values
UPDATE events SET category = 'community'
WHERE category NOT IN (
  'live_music', 'dj_dance', 'comedy', 'theatre', 'open_mic', 'karaoke',
  'art_exhibit', 'film', 'literary', 'tour',
  'happy_hour', 'market',
  'fitness', 'sports', 'outdoors',
  'class', 'trivia_games', 'kids_family',
  'community', 'spectator'
);

-- Step 5: Add new constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_category_check'
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_category_check
      CHECK (category IN (
      'live_music', 'dj_dance', 'comedy', 'theatre', 'open_mic', 'karaoke',
      'art_exhibit', 'film', 'literary', 'tour',
      'happy_hour', 'market',
      'fitness', 'sports', 'outdoors',
      'class', 'trivia_games', 'kids_family',
      'community', 'spectator'
    ));
  END IF;
END $$;
