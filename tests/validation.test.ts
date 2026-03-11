/**
 * Input Validation Tests
 *
 * Verify that validateRequest and validateUuidParam correctly
 * reject bad input and accept good input. These are the gatekeepers
 * for every route handler — if they fail, raw input reaches business logic.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateRequest, validateUuidParam } from '../src/lib/helpers.js';

// ---------------------------------------------------------------------------
// validateRequest
// ---------------------------------------------------------------------------

describe('validateRequest', () => {
  const schema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    count: z.number().int().min(0).optional(),
  });

  it('returns parsed data for valid input', () => {
    const result = validateRequest(schema, { name: 'Test', email: 'a@b.com' });
    expect(result).toEqual({ name: 'Test', email: 'a@b.com' });
  });

  it('throws 400 for missing required fields', () => {
    expect(() => validateRequest(schema, { name: 'Test' })).toThrow();
    try {
      validateRequest(schema, { name: 'Test' });
    } catch (err: unknown) {
      const e = err as { statusCode: number; code: string };
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('VALIDATION_ERROR');
    }
  });

  it('throws 400 for wrong types', () => {
    expect(() => validateRequest(schema, { name: 123, email: 'a@b.com' })).toThrow();
  });

  it('throws 400 for invalid email format', () => {
    expect(() => validateRequest(schema, { name: 'Test', email: 'not-an-email' })).toThrow();
  });

  it('strips extra fields (Zod default behavior)', () => {
    const result = validateRequest(schema, { name: 'Test', email: 'a@b.com', evil: 'payload' });
    expect(result).not.toHaveProperty('evil');
  });

  it('throws for empty string when min(1)', () => {
    expect(() => validateRequest(schema, { name: '', email: 'a@b.com' })).toThrow();
  });

  it('throws for string exceeding max length', () => {
    expect(() => validateRequest(schema, { name: 'x'.repeat(101), email: 'a@b.com' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateUuidParam
// ---------------------------------------------------------------------------

describe('validateUuidParam', () => {
  it('accepts valid UUID v4', () => {
    expect(() => validateUuidParam('123e4567-e89b-12d3-a456-426614174000', 'id')).not.toThrow();
  });

  it('accepts uppercase UUIDs', () => {
    expect(() => validateUuidParam('123E4567-E89B-12D3-A456-426614174000', 'id')).not.toThrow();
  });

  it('throws 400 for empty string', () => {
    expect(() => validateUuidParam('', 'id')).toThrow();
  });

  it('throws 400 for non-UUID string', () => {
    expect(() => validateUuidParam('not-a-uuid', 'id')).toThrow();
  });

  it('throws 400 for null', () => {
    expect(() => validateUuidParam(null, 'id')).toThrow();
  });

  it('throws 400 for undefined', () => {
    expect(() => validateUuidParam(undefined, 'id')).toThrow();
  });

  it('throws 400 for UUID-like but wrong length', () => {
    expect(() => validateUuidParam('123e4567-e89b-12d3-a456', 'id')).toThrow();
  });

  it('throws 400 for SQL injection attempt in UUID param', () => {
    expect(() => validateUuidParam("'; DROP TABLE events; --", 'id')).toThrow();
  });

  it('includes param name in error message', () => {
    try {
      validateUuidParam('bad', 'event ID');
    } catch (err: unknown) {
      expect((err as Error).message).toContain('event ID');
    }
  });
});
