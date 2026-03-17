-- Expand event categories from 15 to 18.
-- Renames: trivia → trivia_games, sports → sports_rec, film_screenings → film_screening
-- Adds: fitness_class, theatre, spectator

-- Migrate existing events to new category keys
UPDATE events SET category = 'trivia_games' WHERE category = 'trivia';
UPDATE events SET category = 'sports_rec' WHERE category = 'sports';
UPDATE events SET category = 'film_screening' WHERE category = 'film_screenings';

-- Migrate series templates too
UPDATE event_series SET category = 'trivia_games' WHERE category = 'trivia';
UPDATE event_series SET category = 'sports_rec' WHERE category = 'sports';
UPDATE event_series SET category = 'film_screening' WHERE category = 'film_screenings';

-- Remove old spectator tag from events (now a category, not a tag)
UPDATE events SET tags = array_remove(tags, 'spectator') WHERE 'spectator' = ANY(tags);
