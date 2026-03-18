/**
 * Newsletter Event Extraction — Neighborhood Commons
 *
 * LLM-based extraction of structured event data from newsletter emails,
 * plus dedup logic for matching against existing Commons events.
 *
 * Uses inference.net (OpenAI-compatible chat completions API).
 * No SDK dependency — direct fetch calls.
 */

import { z } from 'zod';
import { config } from '../config.js';
import { nominatimGeocode } from './geocoding.js';
import { supabaseAdmin } from './supabase.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionMetadata {
  field_confidence: Record<string, number>;
  excerpts: Record<string, string | null>;
}

export interface ExtractedEvent {
  title: string;
  description: string | null;
  start_date: string | null; // YYYY-MM-DD
  start_time: string | null; // HH:MM
  end_time: string | null;   // HH:MM
  location_name: string | null;
  location_address: string | null;
  source_url: string | null;
  confidence: number;
  extraction_metadata: ExtractionMetadata | null;
}

export interface DedupResult {
  matched_event_id: string | null;
  match_confidence: number;
}

// ---------------------------------------------------------------------------
// Zod schema for validating individual events from LLM response
// ---------------------------------------------------------------------------

const fieldConfidenceSchema = z.object({
  title: z.number().min(0).max(1).optional().default(0),
  description: z.number().min(0).max(1).optional().default(0),
  date: z.number().min(0).max(1).optional().default(0),
  start_time: z.number().min(0).max(1).optional().default(0),
  end_time: z.number().min(0).max(1).optional().default(0),
  location: z.number().min(0).max(1).optional().default(0),
  url: z.number().min(0).max(1).optional().default(0),
}).catchall(z.number());

const excerptsSchema = z.object({
  title: z.string().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  date: z.string().nullable().optional().default(null),
  start_time: z.string().nullable().optional().default(null),
  end_time: z.string().nullable().optional().default(null),
  location: z.string().nullable().optional().default(null),
  url: z.string().nullable().optional().default(null),
}).catchall(z.string().nullable());

const extractedEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional().default(null),
  date: z.string().nullable().optional().default(null),
  start_time: z.string().nullable().optional().default(null),
  end_time: z.string().nullable().optional().default(null),
  location: z.string().nullable().optional().default(null),
  url: z.string().nullable().optional().default(null),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  field_confidence: fieldConfidenceSchema.optional().default({}),
  excerpts: excerptsSchema.optional().default({}),
});

// ---------------------------------------------------------------------------
// HTML stripping — reduce token count for LLM
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Time normalization — LLMs often return "7pm" instead of "19:00"
// ---------------------------------------------------------------------------

/**
 * Normalize time strings to HH:MM format for PostgreSQL time columns.
 * Handles: "7pm", "7:30pm", "7:30 PM", "19:00", "7 pm", "12pm", "12:30am"
 */
export function normalizeTime(time: string | null): string | null {
  if (!time) return null;

  const t = time.trim().toLowerCase();

  // Already HH:MM format
  if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5, '0');

  // Match patterns like "7pm", "7:30pm", "7 pm", "7:30 pm", "12am"
  const match = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) return time; // Return as-is if we can't parse; let DB reject if invalid

  let hours = parseInt(match[1], 10);
  const minutes = match[2] || '00';
  const period = match[3];

  if (period === 'pm' && hours < 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;

  return `${hours.toString().padStart(2, '0')}:${minutes}`;
}

// ---------------------------------------------------------------------------
// LLM extraction prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an event extraction assistant for a neighborhood events platform in Philadelphia, PA. Your job is to read community newsletters and extract every discrete, attendable event into structured JSON.

Your guiding principle: **extract generously, report honestly.** If something could plausibly be an event that a person could attend, extract it. Use the confidence score to express uncertainty — don't self-censor by omitting borderline cases. A human reviewer will make the final call.

These newsletters come from Philadelphia neighborhood civic associations (QVNA, NLNA, FNA, Bella Vista Neighbors, SOSNA, EKNA, etc.), local media (Billy Penn, City Cast Philly, Philadelphia Citizen, South Philly Scoop, West Philly Local), business improvement districts (East Passyunk BID, Old City District, Manayunk Dev Corp, South Street Headhouse), cultural institutions (Free Library, Parks & Rec), and family/community sources (Philadelphia Family).

## Output schema

Return a JSON object with an "events" array. For each event, include these fields:

### Core fields (the extracted data)
- title: the event name — use the actual event name, not the newsletter section heading (string, required)
- description: 1-2 sentence summary. Include performers, themes, what to expect. Do NOT repeat the title, time, or location (string or null)
- date: YYYY-MM-DD format. See date rules below (string or null)
- start_time: HH:MM in 24-hour format, e.g. "19:00" not "7pm" (string or null)
- end_time: HH:MM in 24-hour format (string or null)
- location: venue name and/or street address as written. Include both if available, e.g. "Johnny Brenda's, 1201 N Frankford Ave" (string or null)
- url: direct link to the event page or ticket page, not the newsletter URL (string or null)
- confidence: 0.0-1.0 overall confidence (number). See scoring rubric below

### Per-field confidence (how sure you are about each individual field)
- field_confidence: an object mapping field names to 0.0-1.0 scores. Include: title, description, date, start_time, end_time, location, url. Score each field independently:
  - 1.0: field value is explicitly and unambiguously stated in the email
  - 0.7-0.9: field value is clearly implied or requires minor interpretation (e.g., "7pm" → "19:00")
  - 0.4-0.6: field value is inferred from context but not directly stated
  - 0.0: field is null / not found in the email

### Source excerpts (the exact text you based each field on)
- excerpts: an object mapping field names to the exact substring from the email that you used for that field. Copy the text verbatim — do not paraphrase. If a field is null (not found), use null for its excerpt too. These excerpts let the reviewer click through to see exactly what you read in the email.

## Critical rules for field accuracy

**Never invent information.** If a field is not stated or clearly implied in the email, use null. A null field is always better than a guessed one. Specifically:
- If no date is mentioned or inferrable → date: null
- If no time is mentioned → start_time: null, end_time: null
- If no location is mentioned → location: null
- If no URL is in the email → url: null
- If the email says "7-9pm", that's start_time: "19:00", end_time: "21:00"
- If the email says "starts at 8pm" with no end time → end_time: null

## Date interpretation

Newsletters use varied date formats. Use the newsletter's own context to resolve dates:
- "This Thursday" or "Saturday" → resolve relative to the apparent send date of the email
- "March 21-23" → if it's one multi-day event, use the start date. If distinct events per day, create separate entries
- "Every Friday" or "Tuesdays in April" with no specific date → date: null (recurring without a concrete instance)
- If the email provides no dates at all → date: null for all events

## What to extract (be generous)

Extract anything a person could physically attend or participate in:
- **Structured listings**: concerts, markets, festivals, comedy, art openings — the easy cases
- **Community meetings**: civic association meetings, town halls, zoning hearings, public comment sessions — these ARE events
- **Casual mentions**: "come hang at Clark Park Saturday" or "join us at the brewery" — extract these with lower confidence
- **Classes and programs**: yoga, art classes, cooking demos, library talks, rec programs — if a date/time is stated or implied
- **Recurring entertainment**: trivia, open mics, karaoke, happy hours — extract if a specific upcoming date is mentioned
- **Fundraisers, galas, races, group runs, family events, religious/cultural events** open to the public

When in doubt, extract it with a low confidence score. The review queue handles false positives gracefully; missed events are harder to recover.

## What to skip

- Calls for volunteers/submissions/donations with no attendable gathering
- Business openings/closures, construction, government services
- Ads or sponsored content that aren't events
- Deadlines without an associated in-person event
- Newsletter boilerplate: unsubscribe, forward-to-friend, editor notes
- Past event recaps or reviews
- Job postings

## Philadelphia context

- Philly addresses often omit "Philadelphia, PA" — include the address as written
- Venue names are valid locations: "Johnny Brenda's", "Kung Fu Necktie", "The Rail Park", "FDR Park", "Clark Park"
- Neighborhood names are acceptable: "in Fishtown", "Northern Liberties", "East Passyunk"
- BID events may span a corridor: use the district name (e.g. "East Passyunk Avenue")
- The system geocodes separately — just pass through what the email says

## Confidence scoring rubric

- **0.9-1.0**: Clear event with title + date + time + location. A well-structured listing.
- **0.7-0.8**: Clearly an event but missing one or two fields (no time, or vague location like "in Fishtown")
- **0.5-0.6**: Probably an event — enough context to be useful, but details are sparse or ambiguous
- **0.3-0.4**: Could be an event or could be an announcement/program. Extract it, let the reviewer decide.
- **Below 0.3**: Marginal. Only include if there's a plausible reading as an attendable gathering.

Example output:
{"events": [{"title": "Jazz Night", "description": "Local jazz trio performing original compositions.", "date": "2026-03-21", "start_time": "20:00", "end_time": "23:00", "location": "Johnny Brenda's, 1201 N Frankford Ave", "url": null, "confidence": 0.95, "field_confidence": {"title": 1.0, "description": 0.8, "date": 1.0, "start_time": 0.9, "end_time": 0.9, "location": 1.0, "url": 0.0}, "excerpts": {"title": "Jazz Night at Johnny Brenda's", "description": "Local jazz trio performing original compositions and standards", "date": "Friday March 21", "start_time": "8pm-11pm", "end_time": "8pm-11pm", "location": "Johnny Brenda's, 1201 N Frankford Ave", "url": null}}]}

If no events are found: {"events": []}`;

function buildMessages(body: string): Array<{ role: string; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Extract all events from this newsletter:\n\n${body}` },
  ];
}

// ---------------------------------------------------------------------------
// LLM API call
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

/**
 * Call inference.net chat completions API.
 * Returns the raw response content string and the parsed events.
 */
export async function extractEventsFromEmail(
  bodyHtml: string | null,
  bodyPlain: string | null,
): Promise<{ events: ExtractedEvent[]; rawResponse: string }> {
  if (!config.inference.apiKey) {
    console.error('[NEWSLETTER] Inference API key not configured, skipping extraction');
    return { events: [], rawResponse: '' };
  }

  // Prefer HTML (more structure) but strip tags to reduce tokens
  const body = bodyHtml ? stripHtml(bodyHtml) : (bodyPlain || '');
  if (!body.trim()) {
    return { events: [], rawResponse: '' };
  }

  // Truncate to ~15k chars to stay within context limits
  const truncated = body.length > 15000 ? body.substring(0, 15000) + '\n[...truncated]' : body;

  try {
    const model = config.inference.model;
    console.log(`[NEWSLETTER] Calling ${model} for event extraction`);

    const requestBody: Record<string, unknown> = {
      model,
      messages: buildMessages(truncated),
      temperature: 0.1,
      max_tokens: 4096,
    };

    // Schematron models require json_schema response format
    if (model.includes('schematron')) {
      requestBody.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'event_extraction',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              events: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: ['string', 'null'] },
                    date: { type: ['string', 'null'] },
                    start_time: { type: ['string', 'null'] },
                    end_time: { type: ['string', 'null'] },
                    location: { type: ['string', 'null'] },
                    url: { type: ['string', 'null'] },
                    confidence: { type: 'number' },
                    field_confidence: {
                      type: 'object',
                      properties: {
                        title: { type: 'number' },
                        description: { type: 'number' },
                        date: { type: 'number' },
                        start_time: { type: 'number' },
                        end_time: { type: 'number' },
                        location: { type: 'number' },
                        url: { type: 'number' },
                      },
                      required: ['title', 'description', 'date', 'start_time', 'end_time', 'location', 'url'],
                      additionalProperties: false,
                    },
                    excerpts: {
                      type: 'object',
                      properties: {
                        title: { type: ['string', 'null'] },
                        description: { type: ['string', 'null'] },
                        date: { type: ['string', 'null'] },
                        start_time: { type: ['string', 'null'] },
                        end_time: { type: ['string', 'null'] },
                        location: { type: ['string', 'null'] },
                        url: { type: ['string', 'null'] },
                      },
                      required: ['title', 'description', 'date', 'start_time', 'end_time', 'location', 'url'],
                      additionalProperties: false,
                    },
                  },
                  required: ['title', 'description', 'date', 'start_time', 'end_time', 'location', 'url', 'confidence', 'field_confidence', 'excerpts'],
                  additionalProperties: false,
                },
              },
            },
            required: ['events'],
            additionalProperties: false,
          },
        },
      };
    }

    const response = await fetch(`${config.inference.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.inference.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown');
      console.error(`[NEWSLETTER] Inference API HTTP ${response.status}: ${errText}`);
      return { events: [], rawResponse: errText };
    }

    const result = (await response.json()) as ChatCompletionResponse;
    const rawContent = result.choices?.[0]?.message?.content || '';
    console.log(`[NEWSLETTER] LLM raw content (first 500): ${rawContent.substring(0, 500)}`);

    const events = parseExtractionResponse(rawContent);
    console.log(`[NEWSLETTER] Parsed ${events.length} events from LLM response`);
    return { events, rawResponse: rawContent };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NEWSLETTER] Extraction error:', msg);
    return { events: [], rawResponse: `error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseExtractionResponse(raw: string): ExtractedEvent[] {
  // Try parsing the whole response first (structured output returns clean JSON)
  let parsed: unknown[];
  try {
    const full = JSON.parse(raw);
    if (Array.isArray(full)) {
      parsed = full;
    } else if (full && Array.isArray(full.events)) {
      // Structured output wraps in { events: [...] }
      parsed = full.events;
    } else {
      parsed = [];
    }
  } catch {
    // Fallback: find JSON array in the response (LLM may wrap in markdown code blocks)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[NEWSLETTER] No JSON array found in LLM response');
      return [];
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.error('[NEWSLETTER] Failed to parse LLM JSON response');
      return [];
    }
    if (!Array.isArray(parsed)) return [];
  }

  const events: ExtractedEvent[] = [];
  for (const item of parsed) {
    const result = extractedEventSchema.safeParse(item);
    if (!result.success) {
      console.log('[NEWSLETTER] Skipping invalid event from LLM:', result.error.message);
      continue;
    }

    const e = result.data;

    // Build extraction metadata if the LLM provided per-field data
    let extractionMetadata: ExtractionMetadata | null = null;
    if (e.field_confidence && Object.keys(e.field_confidence).length > 0) {
      extractionMetadata = {
        field_confidence: e.field_confidence,
        excerpts: e.excerpts || {},
      };
    }

    events.push({
      title: e.title,
      description: e.description,
      start_date: e.date,
      start_time: normalizeTime(e.start_time),
      end_time: normalizeTime(e.end_time),
      location_name: e.location,
      location_address: e.location, // Use location string as address for geocoding
      source_url: e.url,
      confidence: e.confidence,
      extraction_metadata: extractionMetadata,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Geocoding for candidates
// ---------------------------------------------------------------------------

export async function geocodeCandidate(
  locationName: string | null,
  locationAddress: string | null,
): Promise<{ lat: number; lng: number } | null> {
  const address = locationAddress || locationName;
  if (!address) return null;
  return nominatimGeocode(address);
}

// ---------------------------------------------------------------------------
// Dedup: match candidates against existing events
// ---------------------------------------------------------------------------

/**
 * Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use single-row optimization
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[lb];
}

/**
 * Haversine distance in meters between two lat/lng points.
 */
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => deg * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Check if two titles are similar enough to be considered duplicates.
 * Match if: Levenshtein distance < 30% of the longer title, OR one contains the other.
 */
export function titlesMatch(a: string, b: string): boolean {
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();

  // Substring containment
  if (la.includes(lb) || lb.includes(la)) return true;

  // Levenshtein threshold: 30% of the longer string
  const maxLen = Math.max(la.length, lb.length);
  if (maxLen === 0) return true;
  const distance = levenshteinDistance(la, lb);
  return distance < maxLen * 0.3;
}

/**
 * Find duplicate events in the Commons for a single candidate.
 * All three criteria must match: same date, location within 200m, similar title.
 */
export async function findDuplicate(
  candidate: {
    title: string;
    start_date: string | null;
    location_lat: number | null;
    location_lng: number | null;
  },
): Promise<DedupResult> {
  // Can't dedup without a date
  if (!candidate.start_date) {
    return { matched_event_id: null, match_confidence: 0 };
  }

  // Query events on the same date
  const { data: events, error } = await supabaseAdmin
    .from('events')
    .select('id, content, latitude, longitude, event_at')
    .gte('event_at', `${candidate.start_date}T00:00:00`)
    .lt('event_at', `${candidate.start_date}T23:59:59`)
    .not('status', 'eq', 'deleted')
    .limit(100);

  if (error || !events?.length) {
    return { matched_event_id: null, match_confidence: 0 };
  }

  for (const event of events) {
    const eventTitle = (event.content as string) || '';

    // Title match
    if (!titlesMatch(candidate.title, eventTitle)) continue;

    // Location proximity (only if both have coordinates)
    if (candidate.location_lat != null && candidate.location_lng != null
      && event.latitude != null && event.longitude != null) {
      const distance = haversineDistance(
        candidate.location_lat, candidate.location_lng,
        event.latitude as number, event.longitude as number,
      );
      if (distance > 200) continue;
    }

    // Match found — compute confidence
    // Higher confidence if location matched, lower if only title+date
    const hasLocationMatch = candidate.location_lat != null && event.latitude != null;
    const confidence = hasLocationMatch ? 0.9 : 0.6;

    return {
      matched_event_id: event.id as string,
      match_confidence: confidence,
    };
  }

  return { matched_event_id: null, match_confidence: 0 };
}
