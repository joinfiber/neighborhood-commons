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
}

export interface DedupResult {
  matched_event_id: string | null;
  match_confidence: number;
}

// ---------------------------------------------------------------------------
// Zod schema for validating individual events from LLM response
// ---------------------------------------------------------------------------

const extractedEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional().default(null),
  date: z.string().nullable().optional().default(null),
  start_time: z.string().nullable().optional().default(null),
  end_time: z.string().nullable().optional().default(null),
  location: z.string().nullable().optional().default(null),
  url: z.string().nullable().optional().default(null),
  confidence: z.number().min(0).max(1).optional().default(0.5),
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
// LLM extraction prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an event extraction assistant for a neighborhood events platform in Philadelphia, PA. Your job is to read community newsletters and extract every discrete, attendable event into structured JSON.

These newsletters come from Philadelphia neighborhood civic associations (QVNA, NLNA, FNA, Bella Vista Neighbors, SOSNA, EKNA, etc.), local media (Billy Penn, City Cast Philly, Philadelphia Citizen, South Philly Scoop, West Philly Local), business improvement districts (East Passyunk BID, Old City District, Manayunk Dev Corp, South Street Headhouse), cultural institutions (Free Library, Parks & Rec), and family/community sources (Philadelphia Family).

Return a JSON array of events. For each event, extract:
- title: the event name — use the actual event name, not the newsletter section heading (string, required)
- description: 1-2 sentence summary of what the event is. Include key details like performers, themes, or what attendees can expect. Do NOT repeat the title, time, or location here (string or null)
- date: YYYY-MM-DD format (string or null)
- start_time: HH:MM in 24-hour format (string or null)
- end_time: HH:MM in 24-hour format (string or null)
- location: venue name and street address as written. Include both if available, e.g. "Johnny Brenda's, 1201 N Frankford Ave". If only a venue name or only an address is given, use what's available (string or null)
- url: direct link to the event page, ticket page, or source article — not the newsletter's own URL (string or null)
- confidence: 0.0-1.0 how confident you are this is a real, correctly extracted event (number)

## Date interpretation

Newsletters often use relative dates like "this Thursday," "next Saturday," or "March 21-23." Use the email's send date (if apparent from context) to resolve these to absolute YYYY-MM-DD dates. If the email mentions a date range (e.g. "March 21-23"), create a separate event entry for each day IF distinct events are described for each day. If it's one multi-day event, use the start date.

For recurring events mentioned without a specific date (e.g. "Happy Hour every Friday"), set date to null — do not guess a specific date.

## What IS an event (extract these)

- Public gatherings with a specific time and/or place: concerts, comedy shows, markets, festivals, block parties, art openings, pop-ups, food truck rallies, pub crawls, community clean-ups
- Community meetings: civic association monthly meetings, town halls, zoning hearings, public comment sessions — these ARE events (include them)
- Classes, workshops, and programs: yoga in the park, art classes, cooking demos, library author talks, rec center programs — if they have a specific date/time
- Recurring entertainment: trivia nights, open mics, karaoke, DJ sets, happy hours — extract if a specific upcoming date is mentioned
- Fundraisers, galas, benefit events
- Sports: recreational leagues, races, group runs/rides
- Religious/cultural events that are open to the public
- Kid and family events: storytimes, family festivals, holiday events

## What is NOT an event (skip these)

- Calls for volunteers, submissions, or donations without an attendable gathering
- Announcements about new businesses, closures, or construction projects
- Advertisements or sponsored content that isn't an event
- Deadlines (grant deadlines, registration deadlines) — unless there's an associated in-person event
- Newsletter meta-content: "forward this to a friend," unsubscribe links, editor notes
- Government services or ongoing programs without specific dates (e.g. "trash collection changes")
- Past events being recapped or reviewed
- Job postings or hiring announcements

## Philadelphia-specific guidance

- Philly addresses often omit "Philadelphia, PA" — that's fine, include the address as written
- Common venue abbreviations: "Johnny Brenda's" = 1201 N Frankford Ave, "Kung Fu Necktie" = 1250 N Front St, etc. — use the name as written, the system will geocode separately
- "The Rail Park" is a park in Callowhill. "FDR Park" is in South Philly. "Clark Park" is in West Philly. These are valid locations.
- Neighborhood names alone (e.g. "in Fishtown") are acceptable as location if no address is given
- BID events often span an entire commercial corridor — use the district name as location (e.g. "East Passyunk Avenue")

## Confidence scoring

- 0.9-1.0: Clear event with title, date, time, and location all present
- 0.7-0.8: Event is clear but missing one or two fields (e.g. no specific time, or location is vague)
- 0.5-0.6: Likely an event but details are ambiguous or incomplete
- 0.3-0.4: Might be an event, but could also be an announcement or ongoing program
- Below 0.3: Probably not an event — only include if there's some reason to think it is

## Output format

Return ONLY a JSON array. No markdown, no explanation, no wrapper object. Example:
[
  {
    "title": "Jazz Night at Johnny Brenda's",
    "description": "Local jazz trio performing original compositions and standards.",
    "date": "2026-03-21",
    "start_time": "20:00",
    "end_time": "23:00",
    "location": "Johnny Brenda's, 1201 N Frankford Ave",
    "url": "https://johnnybrendas.com/events/jazz-night",
    "confidence": 0.95
  }
]

If no events are found, return an empty array: []
Do not invent information. If a field is not in the email, use null.`;

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
                  },
                  required: ['title', 'description', 'date', 'start_time', 'end_time', 'location', 'url', 'confidence'],
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
    events.push({
      title: e.title,
      description: e.description,
      start_date: e.date,
      start_time: e.start_time,
      end_time: e.end_time,
      location_name: e.location,
      location_address: e.location, // Use location string as address for geocoding
      source_url: e.url,
      confidence: e.confidence,
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
