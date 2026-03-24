/**
 * Candidate Classification — Neighborhood Commons
 *
 * Uses the inference.net LLM to suggest a category and tags for event candidates.
 * Called after candidates are inserted (from feeds or newsletters) so the admin
 * review screen can pre-fill category/tags instead of defaulting to "community".
 *
 * Reuses the same inference API config as newsletter-extraction.ts.
 */

import { config } from '../config.js';
import { EVENT_CATEGORY_KEYS } from './categories.js';
import { ALL_TAG_SLUGS, validateTags } from './tags.js';
import { supabaseAdmin } from './supabase.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLASSIFY_TIMEOUT_MS = 15_000; // Classification is a small prompt — 15s is plenty

const SYSTEM_PROMPT = `You are a category/tag classifier for a neighborhood events platform. Given an event's title, description, and venue, pick the single best category and up to 5 relevant tags. Classify by the PRIMARY EXPERIENCE — what the attendee is going there to DO.

## Categories (pick exactly ONE)
${EVENT_CATEGORY_KEYS.map(k => `- ${k}`).join('\n')}

## Tags (pick 0-5 from this list)
${ALL_TAG_SLUGS.map(t => `- ${t}`).join('\n')}

## Tag guidance
- Tags describe the experience of attending, not the content
- "free" if the event is free or no cover
- "outdoor" if it takes place outdoors
- "all-ages", "21-plus", "18-plus" for age restrictions (pick one at most)
- "family-friendly" for kid-appropriate events
- "donation-based" if pay-what-you-can or suggested donation
- "drop-in" if no registration needed
- "registration-required" if you must sign up
- "volunteer" for volunteer/service events
- "beginner-friendly" for intro-level classes/activities
- "tasting" for wine/beer/food tastings
- Only use tags that genuinely apply based on the information given

## Category routing rules
- Concert, band, singer-songwriter, live performance → live_music
- DJ, dance party, electronic music, salsa, line dancing → dj_dance
- Comedy show, standup, improv, sketch → comedy
- Play, musical, drag show, burlesque, stage performance → theatre
- Open mic (any kind — comedy, poetry, music) → open_mic
- Karaoke → karaoke
- Art show, gallery opening, exhibition → art_exhibit
- Movie screening, film night → film
- Book reading, author event, poetry reading, book club → literary
- Walking tour, history tour, mural tour, brewery tour → tour
- Happy hour, drink specials, daily food specials → happy_hour
- Farmers market, craft fair, flea market, pop-up, plant swap → market
- Yoga, workout class, run club, cycling class → fitness
- Sports league, pickup game, rec sports → sports
- Birding, gardening, nature walk, hike, clean-up, outdoor activity → outdoors
- Workshop, class, lecture, craft night, skill-building → class
- Trivia, bingo, game night, board games → trivia_games
- Storytime, kids event, family event, children's programming → kids_family
- Parade, fireworks, watch party, pro sports viewing → spectator
- Town hall, neighborhood meeting, fundraiser, volunteer day → community

## Important
- Classify by the PRIMARY experience. A drag brunch is theatre (the show), not food. A wine tasting is class (learning). A food festival is market (browsing vendors).
- If the venue name suggests a bar/restaurant, that alone does NOT make it happy_hour. Classify by what the event IS, not where it happens.
- When in doubt between two categories, pick the one that better describes what the attendee will be DOING.

Respond with ONLY a JSON object: {"category": "category_key", "tags": ["tag1", "tag2"]}
No explanation, no markdown, just the JSON object.`;

// ---------------------------------------------------------------------------
// Core classification
// ---------------------------------------------------------------------------

interface ClassificationResult {
  category: string;
  tags: string[];
}

/**
 * Classify a single candidate by title + description using the LLM.
 * Returns null if inference is not configured or the call fails.
 */
export async function classifyCandidate(
  title: string,
  description: string | null,
  price: string | null,
  venueName?: string | null,
): Promise<ClassificationResult | null> {
  if (!config.inference.apiKey) {
    console.warn('[CLASSIFY] No INFERENCE_API_KEY configured — skipping classification');
    return null;
  }

  try {
    const userContent = [
      `Title: ${title}`,
      venueName ? `Venue: ${venueName}` : null,
      description ? `Description: ${description.slice(0, 500)}` : null,
      price ? `Price: ${price}` : null,
    ].filter(Boolean).join('\n');

    console.log(`[CLASSIFY] Requesting: model=${config.inference.model}, input="${title}"`);

    const response = await fetch(`${config.inference.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.inference.apiKey}`,
      },
      body: JSON.stringify({
        model: config.inference.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 256,
      }),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      console.error(`[CLASSIFY] LLM returned ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      console.warn(`[CLASSIFY] LLM returned empty content for "${title}". Response keys: ${Object.keys(data).join(', ')}`);
      return null;
    }

    // Parse JSON — handle potential markdown wrapping
    const jsonStr = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr) as { category?: string; tags?: string[] };

    // Validate category
    const validCategory = EVENT_CATEGORY_KEYS.includes(parsed.category as typeof EVENT_CATEGORY_KEYS[number]);
    const category = validCategory ? parsed.category as string : 'community';

    if (!validCategory) {
      console.warn(`[CLASSIFY] LLM returned invalid category "${parsed.category}" for "${title}" — falling back to community`);
    }

    // Validate tags against the chosen category
    const rawTags = Array.isArray(parsed.tags) ? parsed.tags.filter(t => typeof t === 'string') : [];
    const tags = validateTags(rawTags, category);

    console.log(`[CLASSIFY] Result for "${title}": ${category} [${tags.join(', ')}]`);
    return { category, tags };
  } catch (err) {
    console.error('[CLASSIFY] Classification failed for "' + title + '":', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Classify multiple candidates in sequence (to be polite to the LLM API).
 * Updates each candidate's category/tags in the database.
 *
 * Designed to be called fire-and-forget after candidate insertion.
 */
export async function classifyCandidates(
  candidates: Array<{ id: string; title: string; description: string | null; price: string | null; venue_name?: string | null }>,
): Promise<void> {
  if (!config.inference.apiKey) {
    console.warn(`[CLASSIFY] Skipping ${candidates.length} candidates — no INFERENCE_API_KEY`);
    return;
  }
  if (candidates.length === 0) return;

  console.log(`[CLASSIFY] Classifying ${candidates.length} candidates (api=${config.inference.apiUrl}, model=${config.inference.model})`);
  let classified = 0;

  for (const candidate of candidates) {
    const result = await classifyCandidate(candidate.title, candidate.description, candidate.price, candidate.venue_name);
    if (result) {
      await supabaseAdmin
        .from('event_candidates')
        .update({ category: result.category, tags: result.tags })
        .eq('id', candidate.id);
      classified++;
    }
  }

  console.log(`[CLASSIFY] Done: ${classified}/${candidates.length} candidates classified`);
}
