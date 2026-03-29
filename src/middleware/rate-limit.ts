/**
 * Rate Limiting — Neighborhood Commons
 *
 * IP-based rate limiting for public endpoints.
 * Portal auth'd routes get higher limits.
 *
 * Disabled in test mode (INTEGRATION_TEST=true) so integration tests
 * can exercise routes without hitting shared in-memory counters.
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';

const isTest = process.env.INTEGRATION_TEST === 'true';

/** No-op middleware for test mode — lets requests through without counting */
const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

/** Global rate limiter (IP-based) */
export const globalLimiter = isTest ? passthrough : rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Write endpoints (stricter) */
export const writeLimiter = isTest ? passthrough : rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Portal CRUD (auth'd, per-user) */
export const portalLimiter = isTest ? passthrough : rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => req.user?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Enumeration protection (auth check, registration) */
export const enumerationLimiter = isTest ? passthrough : rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Service API — trusted tools with valid service-tier keys get generous limits */
export const serviceLimiter = isTest ? passthrough : rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Image upload — stricter limit to prevent storage exhaustion (12MB × 3/min = 36MB/min max) */
export const imageUploadLimiter = isTest ? passthrough : rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: (req: Request) => req.user?.id || req.ip || 'unknown',
  message: { error: { code: 'RATE_LIMIT', message: 'Too many image uploads. Please try again shortly.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * OTP verification — compounds IP + email to prevent distributed
 * brute-force against a single email's OTP code. 5-minute window
 * matches Supabase OTP expiry so the limiter resets with new codes.
 */
export const verifyOtpLimiter = isTest ? passthrough : rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) => {
    const email = ((req.body as Record<string, unknown>)?.email as string || '').toLowerCase().trim();
    return `otp:${req.ip || 'unknown'}:${email}`;
  },
  message: { error: { code: 'RATE_LIMIT', message: 'Too many verification attempts' } },
  standardHeaders: true,
  legacyHeaders: false,
});
