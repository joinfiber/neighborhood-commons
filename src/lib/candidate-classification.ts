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

const SYSTEM_PROMPT = `You are a category/tag classifier for a neighborhood events platform. Given an event's title and description, pick the single best category and up to 5 relevant tags.

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
- Only use tags that genuinely apply based on the information given

## Rules
- If the event is clearly a concert, band, or live performance → live_music
- If DJ, dance party, electronic music → dj_dance
- If comedy show, standup → comedy
- If open mic (any kind) → open_mic
- If karaoke → karaoke
- If art show, gallery, exhibition → art_gallery
- If movie, film → film_screening
- If play, musical, stage → theatre
- If happy hour, drink specials → happy_hour
- If food event, tasting, dinner → food_drink
- If market, pop-up, vendor → market_popup
- If yoga, fitness, workout → fitness_class
- If sports, run, bike, rec league → sports_rec
- If workshop, class, lecture, talk → workshop_class
- If trivia, game night, board games, bingo → trivia_games
- If spectator event (parade, fireworks, viewing party) → spectator
- If community meeting, cleanup, general gathering, volunteer day → community
- If nothing else fits → other

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
): Promise<ClassificationResult | null> {
  if (!config.inference.apiKey) {
    return null; // No LLM configured — skip silently
  }

  try {
    const userContent = [
      `Title: ${title}`,
      description ? `Description: ${description.slice(0, 500)}` : null,
      price ? `Price: ${price}` : null,
    ].filter(Boolean).join('\n');

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
      console.error(`[CLASSIFY] LLM returned ${response.status}`);
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    // Parse JSON — handle potential markdown wrapping
    const jsonStr = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr) as { category?: string; tags?: string[] };

    // Validate category
    const category = EVENT_CATEGORY_KEYS.includes(parsed.category as typeof EVENT_CATEGORY_KEYS[number])
      ? parsed.category as string
      : 'community';

    // Validate tags against the chosen category
    const rawTags = Array.isArray(parsed.tags) ? parsed.tags.filter(t => typeof t === 'string') : [];
    const tags = validateTags(rawTags, category);

    return { category, tags };
  } catch (err) {
    console.error('[CLASSIFY] Classification failed:', err instanceof Error ? err.message : err);
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
  candidates: Array<{ id: string; title: string; description: string | null; price: string | null }>,
): Promise<void> {
  if (!config.inference.apiKey || candidates.length === 0) return;

  console.log(`[CLASSIFY] Classifying ${candidates.length} candidates...`);
  let classified = 0;

  for (const candidate of candidates) {
    const result = await classifyCandidate(candidate.title, candidate.description, candidate.price);
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
