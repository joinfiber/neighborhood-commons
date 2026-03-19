/**
 * Feed Polling — Neighborhood Commons
 *
 * Pull-based event ingestion: fetch iCal/RSS/Eventbrite feeds on a schedule,
 * parse events, and insert as candidates for admin review.
 *
 * Reuses parsers from import-parsers.ts and dedup/geocoding from
 * newsletter-extraction.ts. No new dependencies.
 */

import { supabaseAdmin } from './supabase.js';
import { parseIcalFeed, parseEventbritePage, detectFormat, type ImportedEvent } from './import-parsers.js';
import { geocodeCandidate, findDuplicate, fetchImagesForCandidates } from './newsletter-extraction.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedSourceRow {
  id: string;
  name: string;
  feed_url: string;
  feed_type: string;
  poll_interval_hours: number;
  status: string;
  default_location: string | null;
  default_timezone: string | null;
  last_polled_at: string | null;
}

interface PollResult {
  sourceId: string;
  sourceName: string;
  candidateCount: number;
  skippedDuplicates: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEED_FETCH_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Core polling
// ---------------------------------------------------------------------------

/**
 * Poll a single feed source: fetch, parse, dedup, geocode, insert candidates.
 */
export async function pollFeedSource(source: FeedSourceRow): Promise<PollResult> {
  const result: PollResult = {
    sourceId: source.id,
    sourceName: source.name,
    candidateCount: 0,
    skippedDuplicates: 0,
    error: null,
  };

  try {
    // Fetch the feed
    const response = await fetch(source.feed_url, {
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)',
        'Accept': 'text/calendar, text/html, application/xml, application/json, */*',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${source.feed_url}`);
    }

    const content = await response.text();
    const contentType = response.headers.get('content-type') || '';
    const timezone = source.default_timezone || 'America/New_York';

    // Detect format and parse
    const format = source.feed_type === 'ical' || source.feed_type === 'eventbrite'
      ? source.feed_type
      : detectFormat(source.feed_url, contentType, content);

    let events: ImportedEvent[];
    if (format === 'ical') {
      events = parseIcalFeed(content, timezone);
    } else if (format === 'eventbrite') {
      events = parseEventbritePage(content, source.feed_url, timezone);
    } else {
      throw new Error(`Unsupported feed format: ${format}`);
    }

    console.log(`[FEED] Parsed ${events.length} events from "${source.name}"`);

    if (events.length === 0) {
      await updatePollStatus(source.id, 'no_new_events', null, 0);
      return result;
    }

    // Filter to future events only (no point importing past events)
    const now = new Date();
    const futureEvents = events.filter(e => new Date(e.start) >= now);
    console.log(`[FEED] ${futureEvents.length} future events (${events.length - futureEvents.length} past events skipped)`);

    // Process each event
    const insertedCandidates: Array<{ id: string; source_url: string | null }> = [];

    for (const event of futureEvents) {
      const candidate = mapImportedEventToCandidate(event, source);

      // Intra-feed dedup: skip if we already have a candidate from this feed
      // with the same title and date
      const { data: existing } = await supabaseAdmin
        .from('event_candidates')
        .select('id')
        .eq('feed_source_id', source.id)
        .eq('title', candidate.title)
        .eq('start_date', candidate.start_date)
        .limit(1);

      if (existing && existing.length > 0) {
        result.skippedDuplicates++;
        continue;
      }

      // Geocode
      const coords = await geocodeCandidate(
        candidate.location_name,
        candidate.location_address || source.default_location,
      );

      // Cross-system dedup against existing Commons events
      const dedup = await findDuplicate({
        title: candidate.title,
        start_date: candidate.start_date,
        location_lat: coords?.lat || null,
        location_lng: coords?.lng || null,
      });

      // Insert candidate
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('event_candidates')
        .insert({
          feed_source_id: source.id,
          source_id: null,
          email_id: null,
          title: candidate.title,
          description: candidate.description,
          start_date: candidate.start_date,
          start_time: candidate.start_time,
          end_time: candidate.end_time,
          location_name: candidate.location_name,
          location_address: candidate.location_address,
          location_lat: coords?.lat || null,
          location_lng: coords?.lng || null,
          source_url: candidate.source_url,
          confidence: 0.9, // Structured feeds are high-confidence
          matched_event_id: dedup.matched_event_id,
          match_confidence: dedup.match_confidence > 0 ? dedup.match_confidence : null,
          candidate_image_url: candidate.image_url,
        })
        .select('id')
        .single();

      if (insertErr) {
        console.error(`[FEED] Insert error for "${candidate.title}":`, insertErr.message);
      } else {
        result.candidateCount++;
        insertedCandidates.push({ id: inserted.id as string, source_url: candidate.source_url });
      }
    }

    // Fire-and-forget: fetch og:image for candidates without images
    const needsImage = insertedCandidates.filter(c => c.source_url);
    if (needsImage.length > 0) {
      void fetchImagesForCandidates(needsImage).then(async (imageMap) => {
        for (const c of needsImage) {
          if (!c.source_url) continue;
          const imageUrl = imageMap.get(c.source_url);
          if (imageUrl) {
            await supabaseAdmin
              .from('event_candidates')
              .update({ candidate_image_url: imageUrl })
              .eq('id', c.id);
          }
        }
      }).catch(err => {
        console.error('[FEED] Image fetch error:', err instanceof Error ? err.message : err);
      });
    }

    await updatePollStatus(source.id, 'success', null, result.candidateCount);
    console.log(`[FEED] "${source.name}": ${result.candidateCount} new candidates, ${result.skippedDuplicates} duplicates skipped`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FEED] Poll failed for "${source.name}":`, msg);
    result.error = msg;
    await updatePollStatus(source.id, 'failed', msg, 0);
  }

  return result;
}

/**
 * Poll all active feed sources that are due for refresh.
 */
export async function pollAllActiveSources(): Promise<{
  polled: number;
  totalCandidates: number;
  results: PollResult[];
}> {
  const { data: sources, error } = await supabaseAdmin
    .from('feed_sources')
    .select('id, name, feed_url, feed_type, poll_interval_hours, status, default_location, default_timezone, last_polled_at')
    .eq('status', 'active');

  if (error || !sources) {
    console.error('[FEED] Failed to fetch feed sources:', error?.message);
    return { polled: 0, totalCandidates: 0, results: [] };
  }

  // Filter to sources due for refresh
  const now = Date.now();
  const dueSources = sources.filter((s) => {
    if (!s.last_polled_at) return true; // Never polled
    const lastPolled = new Date(s.last_polled_at as string).getTime();
    const intervalMs = ((s.poll_interval_hours as number) || 24) * 60 * 60 * 1000;
    return now - lastPolled >= intervalMs;
  });

  console.log(`[FEED] ${dueSources.length}/${sources.length} active sources due for polling`);

  const results: PollResult[] = [];
  let totalCandidates = 0;

  // Poll sequentially to be polite to external servers
  for (const source of dueSources) {
    const result = await pollFeedSource(source as unknown as FeedSourceRow);
    results.push(result);
    totalCandidates += result.candidateCount;
  }

  console.log(`[FEED] Polling complete: ${dueSources.length} sources, ${totalCandidates} new candidates`);
  return { polled: dueSources.length, totalCandidates, results };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map an ImportedEvent (from import-parsers) to the event_candidates insert shape.
 */
function mapImportedEventToCandidate(
  event: ImportedEvent,
  source: FeedSourceRow,
): {
  title: string;
  description: string | null;
  start_date: string | null;
  start_time: string | null;
  end_time: string | null;
  location_name: string | null;
  location_address: string | null;
  source_url: string | null;
  image_url: string | null;
} {
  // Parse ISO 8601 start into date + time
  const startDate = event.start ? event.start.slice(0, 10) : null; // YYYY-MM-DD
  const startTime = extractTime(event.start);
  const endTime = extractTime(event.end);

  return {
    title: event.name,
    description: event.description ? event.description.slice(0, 2000) : null,
    start_date: startDate,
    start_time: startTime,
    end_time: endTime,
    location_name: event.venue_name || source.default_location || null,
    location_address: event.address || null,
    source_url: event.url || null,
    image_url: event.image_url || null,
  };
}

/**
 * Extract HH:MM time from an ISO 8601 datetime string.
 * Returns null for all-day events (date only).
 */
function extractTime(iso: string | null): string | null {
  if (!iso) return null;
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

/**
 * Update a feed source's poll status in the database.
 */
async function updatePollStatus(
  sourceId: string,
  result: string,
  error: string | null,
  eventCount: number,
): Promise<void> {
  await supabaseAdmin
    .from('feed_sources')
    .update({
      last_polled_at: new Date().toISOString(),
      last_poll_result: result,
      last_poll_error: error,
      last_event_count: eventCount,
    })
    .eq('id', sourceId);
}
