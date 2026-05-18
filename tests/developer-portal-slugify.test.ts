/**
 * Slug derivation unit tests.
 *
 * baseSlug() is pure — no DB involved. deriveUniqueSlug() is a thin
 * wrapper that queries existing slugs and suffixes if needed; tested
 * via the integration tests where Supabase is mocked.
 */

import { describe, it, expect } from 'vitest';
import { baseSlug, SLUG_FORMAT } from '../src/lib/developer-portal/slugify.js';

describe('baseSlug', () => {
  it('lowercases and hyphenates a typical app name', () => {
    expect(baseSlug('Merrie')).toBe('merrie');
    expect(baseSlug('Go There by Bike')).toBe('go-there-by-bike');
    expect(baseSlug('Holler')).toBe('holler');
  });

  it("strips apostrophes (curly and straight) instead of hyphenating", () => {
    // Merrie's → merries (not merrie-s)
    expect(baseSlug("Merrie's")).toBe('merries');
    expect(baseSlug('Alice’s Chess Club')).toBe('alices-chess-club');
  });

  it('collapses runs of whitespace and punctuation into a single hyphen', () => {
    expect(baseSlug('foo   bar')).toBe('foo-bar');
    expect(baseSlug('foo--bar')).toBe('foo-bar');
    expect(baseSlug('foo, bar & baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing hyphens', () => {
    expect(baseSlug('  Hello  ')).toBe('hello');
    expect(baseSlug('--Hello--')).toBe('hello');
    expect(baseSlug('!Hello!')).toBe('hello');
  });

  it('drops non-ASCII characters (accented letters, emoji)', () => {
    expect(baseSlug('Café Olé')).toBe('caf-ol');
    expect(baseSlug('Joy 🎉 App')).toBe('joy-app');
  });

  it('handles numbers', () => {
    expect(baseSlug('App 2 the Future')).toBe('app-2-the-future');
    expect(baseSlug('1Password')).toBe('1password');
  });

  it('returns empty string when no characters survive', () => {
    expect(baseSlug('!!!')).toBe('');
    expect(baseSlug('   ')).toBe('');
    expect(baseSlug('🎉🎉🎉')).toBe('');
  });

  it('caps the slug at 100 characters', () => {
    const long = 'a'.repeat(200);
    expect(baseSlug(long)).toHaveLength(100);
  });
});

describe('SLUG_FORMAT regex', () => {
  it('accepts valid slugs', () => {
    expect(SLUG_FORMAT.test('merrie')).toBe(true);
    expect(SLUG_FORMAT.test('go-there-by-bike')).toBe(true);
    expect(SLUG_FORMAT.test('a')).toBe(true);
    expect(SLUG_FORMAT.test('1password')).toBe(true);
    expect(SLUG_FORMAT.test('app-2')).toBe(true);
  });

  it('rejects slugs starting with a hyphen', () => {
    expect(SLUG_FORMAT.test('-merrie')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(SLUG_FORMAT.test('Merrie')).toBe(false);
  });

  it('rejects non-alphanumeric characters except hyphen', () => {
    expect(SLUG_FORMAT.test('merrie!')).toBe(false);
    expect(SLUG_FORMAT.test('merrie/holler')).toBe(false);
    expect(SLUG_FORMAT.test('merrie_holler')).toBe(false);
  });

  it('rejects slugs longer than 100 chars', () => {
    expect(SLUG_FORMAT.test('a'.repeat(101))).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(SLUG_FORMAT.test('')).toBe(false);
  });
});
