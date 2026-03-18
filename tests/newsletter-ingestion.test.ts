/**
 * Newsletter Ingestion Tests
 *
 * Tests for the newsletter event extraction pipeline:
 * - Mailgun HMAC signature validation
 * - LLM response parsing
 * - Levenshtein distance calculation
 * - Haversine distance calculation
 * - Dedup title matching
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

// Import the pure functions we can test without mocking
import {
  parseExtractionResponse,
  levenshteinDistance,
  haversineDistance,
  titlesMatch,
} from '../src/lib/newsletter-extraction.js';

// ---------------------------------------------------------------------------
// Levenshtein distance
// ---------------------------------------------------------------------------

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns length of non-empty string when other is empty', () => {
    expect(levenshteinDistance('hello', '')).toBe(5);
    expect(levenshteinDistance('', 'hello')).toBe(5);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('calculates single-character edits', () => {
    expect(levenshteinDistance('cat', 'hat')).toBe(1); // substitution
    expect(levenshteinDistance('cat', 'cats')).toBe(1); // insertion
    expect(levenshteinDistance('cats', 'cat')).toBe(1); // deletion
  });

  it('handles multi-character differences', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('saturday', 'sunday')).toBe(3);
  });

  it('handles completely different strings', () => {
    expect(levenshteinDistance('abc', 'xyz')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Haversine distance
// ---------------------------------------------------------------------------

describe('haversineDistance', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineDistance(39.9526, -75.1652, 39.9526, -75.1652)).toBe(0);
  });

  it('calculates short distances accurately', () => {
    // Two points ~110m apart in Philadelphia (roughly 0.001 degree latitude)
    const distance = haversineDistance(39.9526, -75.1652, 39.9536, -75.1652);
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(120);
  });

  it('calculates city-scale distances', () => {
    // Philadelphia to New York: ~130km
    const distance = haversineDistance(39.9526, -75.1652, 40.7128, -74.0060);
    expect(distance).toBeGreaterThan(120000);
    expect(distance).toBeLessThan(140000);
  });

  it('handles equator distances', () => {
    // 1 degree of longitude at the equator is ~111km
    const distance = haversineDistance(0, 0, 0, 1);
    expect(distance).toBeGreaterThan(110000);
    expect(distance).toBeLessThan(112000);
  });
});

// ---------------------------------------------------------------------------
// Title matching
// ---------------------------------------------------------------------------

describe('titlesMatch', () => {
  it('matches identical titles', () => {
    expect(titlesMatch('Open Mic Night', 'Open Mic Night')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(titlesMatch('Open Mic Night', 'open mic night')).toBe(true);
  });

  it('matches when one contains the other', () => {
    expect(titlesMatch('Open Mic Night', 'Open Mic Night at The Bar')).toBe(true);
    expect(titlesMatch('Jazz at the Lounge', 'Jazz')).toBe(true);
  });

  it('matches similar titles within threshold', () => {
    // "Open Mic Night" vs "Open Mic Nite" — distance 3, length 14 — 3/14 = 21% < 30%
    expect(titlesMatch('Open Mic Night', 'Open Mic Nite')).toBe(true);
  });

  it('rejects clearly different titles', () => {
    expect(titlesMatch('Jazz Night', 'Comedy Show')).toBe(false);
    expect(titlesMatch('Open Mic', 'Yoga Class')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(titlesMatch('', '')).toBe(true);
    expect(titlesMatch('Event', '')).toBe(true); // empty is substring of anything
  });
});

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

describe('parseExtractionResponse', () => {
  it('parses valid JSON array of events', () => {
    const raw = JSON.stringify([
      {
        title: 'Jazz Night',
        description: 'Live jazz at the Blue Note',
        date: '2025-03-20',
        start_time: '20:00',
        end_time: '23:00',
        location: 'Blue Note Jazz Club',
        url: 'https://example.com/jazz',
        confidence: 0.95,
      },
      {
        title: 'Poetry Reading',
        description: null,
        date: '2025-03-21',
        start_time: '19:00',
        end_time: null,
        location: 'City Library',
        url: null,
        confidence: 0.8,
      },
    ]);

    const events = parseExtractionResponse(raw);
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('Jazz Night');
    expect(events[0].start_date).toBe('2025-03-20');
    expect(events[0].start_time).toBe('20:00');
    expect(events[0].confidence).toBe(0.95);
    expect(events[1].title).toBe('Poetry Reading');
    expect(events[1].source_url).toBeNull();
  });

  it('returns empty array for empty JSON array', () => {
    expect(parseExtractionResponse('[]')).toEqual([]);
  });

  it('returns empty array for non-JSON input', () => {
    expect(parseExtractionResponse('No events found in this email.')).toEqual([]);
  });

  it('handles markdown code block wrapping', () => {
    const raw = '```json\n[{"title": "Test Event", "confidence": 0.9}]\n```';
    const events = parseExtractionResponse(raw);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Test Event');
  });

  it('handles structured output wrapper { events: [...] }', () => {
    const raw = JSON.stringify({
      events: [
        { title: 'Structured Event', description: null, date: '2025-04-01', start_time: '19:00', end_time: null, location: 'The Venue', url: null, confidence: 0.85 },
      ],
    });
    const events = parseExtractionResponse(raw);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Structured Event');
    expect(events[0].start_date).toBe('2025-04-01');
    expect(events[0].confidence).toBe(0.85);
  });

  it('skips events without required title field', () => {
    const raw = JSON.stringify([
      { title: 'Valid Event', confidence: 0.8 },
      { description: 'Missing title', confidence: 0.5 },
      { title: '', confidence: 0.5 }, // empty title should fail min(1) check
    ]);
    const events = parseExtractionResponse(raw);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Valid Event');
  });

  it('provides defaults for optional fields', () => {
    const raw = JSON.stringify([{ title: 'Minimal Event' }]);
    const events = parseExtractionResponse(raw);
    expect(events).toHaveLength(1);
    expect(events[0].description).toBeNull();
    expect(events[0].start_date).toBeNull();
    expect(events[0].start_time).toBeNull();
    expect(events[0].confidence).toBe(0.5); // default
  });

  it('rejects confidence values outside 0-1 range', () => {
    const raw = JSON.stringify([
      { title: 'Event A', confidence: 1.5 },
      { title: 'Event B', confidence: -0.1 },
      { title: 'Event C', confidence: 0.7 },
    ]);
    const events = parseExtractionResponse(raw);
    // Event A and B should be filtered out due to invalid confidence
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Event C');
  });

  it('handles malformed JSON gracefully', () => {
    expect(parseExtractionResponse('[{broken json')).toEqual([]);
    expect(parseExtractionResponse('{"not": "an array"}')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mailgun HMAC signature validation (unit test the algorithm)
// ---------------------------------------------------------------------------

describe('mailgun HMAC signature', () => {
  const signingKey = 'test-mailgun-signing-key';

  function computeSignature(timestamp: string, token: string): string {
    const hmac = crypto.createHmac('sha256', signingKey);
    hmac.update(timestamp + token);
    return hmac.digest('hex');
  }

  it('produces consistent signatures', () => {
    const ts = '1234567890';
    const token = 'abc123def456';
    const sig1 = computeSignature(ts, token);
    const sig2 = computeSignature(ts, token);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different timestamps', () => {
    const token = 'abc123';
    const sig1 = computeSignature('1000', token);
    const sig2 = computeSignature('2000', token);
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different tokens', () => {
    const ts = '1234567890';
    const sig1 = computeSignature(ts, 'token-a');
    const sig2 = computeSignature(ts, 'token-b');
    expect(sig1).not.toBe(sig2);
  });

  it('detects tampered signatures via timing-safe comparison', () => {
    const ts = '1234567890';
    const token = 'valid-token';
    const validSig = computeSignature(ts, token);
    const tamperedSig = 'a'.repeat(validSig.length);

    expect(
      crypto.timingSafeEqual(
        Buffer.from(validSig, 'hex'),
        Buffer.from(validSig, 'hex'),
      ),
    ).toBe(true);

    expect(
      crypto.timingSafeEqual(
        Buffer.from(validSig, 'hex'),
        Buffer.from(tamperedSig, 'hex'),
      ),
    ).toBe(false);
  });
});
