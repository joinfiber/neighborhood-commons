/**
 * iCal escape tests — S4 (CRLF injection defense)
 *
 * The threat: a venue's `link_url` ends up as `URL:<value>` in the feed.
 * If an attacker can plant `\r\n` inside that value, the feed splits into
 * attacker-controlled VEVENT records that phish via any calendar client
 * that auto-subscribes.
 *
 * Before this PR, `URL:` was emitted un-escaped in three places and the
 * shared escaper (`escapeICalText` / `esc`) didn't handle `\r`. These
 * tests lock in the new policy.
 */

import { describe, it, expect } from 'vitest';
import { icsEscape, icsSafeUrl } from '../src/lib/ical.js';

describe('icsEscape', () => {
  it('escapes backslash, semicolon, comma, LF per RFC 5545', () => {
    expect(icsEscape('a\\b')).toBe('a\\\\b');
    expect(icsEscape('a;b')).toBe('a\\;b');
    expect(icsEscape('a,b')).toBe('a\\,b');
    expect(icsEscape('a\nb')).toBe('a\\nb');
  });

  it('escapes CR (the missing case that enabled injection)', () => {
    expect(icsEscape('a\rb')).toBe('a\\nb');
    expect(icsEscape('a\r\nb')).toBe('a\\nb');
  });

  it('folds \\r\\n into a single escape sequence', () => {
    expect(icsEscape('one\r\ntwo\r\nthree')).toBe('one\\ntwo\\nthree');
  });

  it('strips other C0 control characters', () => {
    // NUL, SOH, STX, ETX, BEL, BS, VT, FF, SI through US, DEL
    expect(icsEscape('a\x00b\x01c\x07d\x7fe')).toBe('abcde');
  });

  it('preserves tab (RFC 5545 permits HTAB in TEXT values)', () => {
    expect(icsEscape('a\tb')).toBe('a\tb');
  });

  it('combines multiple escapes correctly', () => {
    const input = 'Summary, with;special\ncharacters and a\\backslash';
    const expected = 'Summary\\, with\\;special\\ncharacters and a\\\\backslash';
    expect(icsEscape(input)).toBe(expected);
  });

  it('leaves normal text unchanged', () => {
    expect(icsEscape('Open mic night at the coffee shop')).toBe('Open mic night at the coffee shop');
  });
});

describe('icsSafeUrl — URL: field hardening', () => {
  it('returns a safe URL unchanged for legitimate input', () => {
    expect(icsSafeUrl('https://example.com/events/123')).toBe('https://example.com/events/123');
  });

  it('returns null for URL containing CR — no URL: line gets emitted', () => {
    expect(icsSafeUrl('https://good.com/\r\nBEGIN:VEVENT\r\nSUMMARY:pwned')).toBeNull();
  });

  it('returns null for URL containing LF', () => {
    expect(icsSafeUrl('https://good.com/\npayload')).toBeNull();
  });

  it('returns null for URL containing NUL or other control chars', () => {
    expect(icsSafeUrl('https://good.com/\x00')).toBeNull();
    expect(icsSafeUrl('https://good.com/\x07')).toBeNull();
  });

  it('returns null for null/empty input (no URL: line emitted)', () => {
    expect(icsSafeUrl(null)).toBeNull();
    expect(icsSafeUrl(undefined)).toBeNull();
    expect(icsSafeUrl('')).toBeNull();
  });

  it('escapes commas and semicolons that appear in legitimate URLs', () => {
    // Some URLs do contain commas and semicolons in query strings
    expect(icsSafeUrl('https://example.com/search?q=a,b;c')).toBe('https://example.com/search?q=a\\,b\\;c');
  });

  it('escapes backslash (unusual but possible in URLs)', () => {
    expect(icsSafeUrl('https://example.com/path\\with\\backslash')).toBe('https://example.com/path\\\\with\\\\backslash');
  });
});

describe('injection defense — the attack this fixes', () => {
  it('a link_url attack that would split the calendar feed is neutralized', () => {
    // Attacker plants: URL:https://evil\r\nBEGIN:VEVENT\r\nSUMMARY:CEO phishing call
    // If emitted raw, a calendar parser sees two events.
    // icsSafeUrl rejects the whole line by returning null.
    const attack = 'https://evil.com/\r\nBEGIN:VEVENT\r\nSUMMARY:Phish';
    expect(icsSafeUrl(attack)).toBeNull();
  });

  it('a SUMMARY containing a CR cannot inject a new line', () => {
    // Even if the attacker smuggles CR past validateRequest, icsEscape folds
    // all line terminators into literal \n escapes.
    const evil = 'Normal title\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:fake';
    const escaped = icsEscape(evil);
    // Result should contain no raw newlines
    expect(escaped).not.toMatch(/\r|\n/);
    // And should start with the visible content
    expect(escaped.startsWith('Normal title\\n')).toBe(true);
  });
});
