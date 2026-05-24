/**
 * Developer portal — CAPTCHA gate on registration.
 *
 * Boots the app with CAPTCHA enabled (env set before config loads) and asserts:
 *   - GET /developers/sign-up renders the Turnstile widget + site key
 *   - POST /developers/register without a Turnstile token is rejected
 *
 * The live widget-solve (browser) isn't exercised here — only the server-side
 * gate and the rendered markup, which is what we control.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';

vi.hoisted(() => {
  // Enable CAPTCHA before config.ts loads. setup.ts provides the base env;
  // these three flip the Commons into captcha-required mode for this file only.
  process.env.CAPTCHA_ENABLED = 'true';
  process.env.TURNSTILE_SECRET_KEY = 'test-turnstile-secret';
  process.env.TURNSTILE_SITE_KEY = 'test-site-key-0xABC';
});

vi.mock('../src/lib/supabase.js', () => {
  function chain() {
    const c: Record<string, unknown> = {};
    const methods = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in', 'contains',
      'insert', 'update', 'delete', 'upsert', 'maybeSingle', 'single',
    ];
    for (const m of methods) c[m] = () => c;
    c.then = (resolve: (v: unknown) => void) => Promise.resolve({ data: null, error: null }).then(resolve);
    return c;
  }
  return {
    supabaseAdmin: { from: () => chain(), auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) } },
    createUserClient: () => ({ from: () => chain() }),
  };
});

vi.mock('../src/lib/developer-otp.js', () => ({
  storeOtp: vi.fn(async () => '12345678'),
  verifyOtp: vi.fn(async () => false),
  sendOtpEmail: vi.fn(async () => undefined),
}));

import { createApp } from '../src/app.js';

let server: Server;
let baseUrl: string;

beforeAll(() => {
  const app = createApp();
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => new Promise<void>((resolve) => { server?.close(() => resolve()); }));

function csrfFromSetCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/nc_dev_csrf=([^;]+)/);
  return m ? m[1]! : '';
}

describe('CAPTCHA gate on developer registration', () => {
  it('renders the Turnstile widget + site key on the sign-up form', async () => {
    const res = await fetch(`${baseUrl}/developers/sign-up`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('cf-turnstile');
    expect(html).toContain('data-sitekey="test-site-key-0xABC"');
    expect(html).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
  });

  it('rejects registration when the Turnstile token is missing', async () => {
    const getRes = await fetch(`${baseUrl}/developers/sign-up`, { redirect: 'manual' });
    const csrf = csrfFromSetCookie(getRes);
    expect(csrf).not.toBe('');

    const body = new URLSearchParams({
      _csrf: csrf,
      email: 'dev@example.com',
      app_name: 'Test App',
      tagline: 'A tagline',
      description: 'A description',
      app_url: 'https://example.com',
      what_youre_building: 'Collecting public yoga schedules across Philly.',
      verification_process: 'Teachers add their own classes in my app.',
      // no cf-turnstile-response
    });

    const res = await fetch(`${baseUrl}/developers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `nc_dev_csrf=${csrf}`,
      },
      body: body.toString(),
      redirect: 'manual',
    });

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('verification challenge');
  });
});
