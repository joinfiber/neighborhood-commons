-- Expand event categories from 15 to 18.
-- Renames: trivia → trivia_games, sports → sports_rec, film_screenings → film_screening
-- Adds: fitness_class, theatre, spectator

-- Migrate existing events to new category keys
UPDATE events SET category = 'trivia_games' WHERE category = 'trivia';
UPDATE events SET category = 'sports_rec' WHERE category = 'sports';
UPDATE events SET category = 'film_screening' WHERE category = 'film_screenings';

-- Migrate series templates (category lives inside base_event_data jsonb)
UPDATE event_series
  SET base_event_data = jsonb_set(base_event_data, '{category}', '"trivia_games"')
  WHERE base_event_data->>'category' = 'trivia';
UPDATE event_series
  SET base_event_data = jsonb_set(base_event_data, '{category}', '"sports_rec"')
  WHERE base_event_data->>'category' = 'sports';
UPDATE event_series
  SET base_event_data = jsonb_set(base_event_data, '{category}', '"film_screening"')
  WHERE base_event_data->>'category' = 'film_screenings';

-- Remove old spectator tag from events (now a category, not a tag)
UPDATE events SET tags = array_remove(tags, 'spectator') WHERE 'spectator' = ANY(tags);
