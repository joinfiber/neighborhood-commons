/**
 * Cloudflare Turnstile CAPTCHA Verification
 *
 * Verifies CAPTCHA tokens from the Turnstile widget on public forms.
 * Turnstile is a privacy-friendly alternative to reCAPTCHA that doesn't
 * require user interaction in most cases.
 *
 * @see https://developers.cloudflare.com/turnstile/
 */

import { config } from '../config.js';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

/**
 * Verify a Turnstile CAPTCHA token.
 *
 * @param token - The token from the Turnstile widget (cf-turnstile-response)
 * @param remoteIp - Optional client IP for additional validation
 * @returns true if the token is valid, false otherwise
 */
export async function verifyTurnstile(token: string, remoteIp?: string): Promise<boolean> {
  // Skip verification if CAPTCHA is disabled (development/testing)
  if (!config.captcha.enabled) {
    console.warn('[CAPTCHA] Verification skipped - CAPTCHA disabled');
    return true;
  }

  if (!config.captcha.secretKey) {
    console.error('[CAPTCHA] Secret key not configured');
    return false;
  }

  if (!token) {
    console.warn('[CAPTCHA] No token provided');
    return false;
  }

  try {
    const body: Record<string, string> = {
      secret: config.captcha.secretKey,
      response: token,
    };

    if (remoteIp) {
      body.remoteip = remoteIp;
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error('[CAPTCHA] Turnstile API error:', response.status);
      return false;
    }

    const data = (await response.json()) as TurnstileResponse;

    if (!data.success) {
      console.warn('[CAPTCHA] Verification failed:', data['error-codes']?.join(', '));
    }

    return data.success === true;
  } catch (error) {
    console.error('[CAPTCHA] Verification error:', error);
    // Fail open in case of network errors to avoid blocking legitimate users
    // Consider changing this to fail closed (return false) for higher security
    return false;
  }
}
