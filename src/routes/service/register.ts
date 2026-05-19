/**
 * Legacy service-tier self-registration — retired 2026-05-19.
 *
 * The flow that used to live here (POST /send-otp + POST /verify-otp)
 * was superseded by the developer portal at /developers/sign-up. The
 * portal does everything the old flow did, plus:
 *   - links a public contributor_profile to each api_key
 *   - issues a DB-backed dashboard session
 *   - supports magic-link returning login
 *   - supports TOTP MFA + step-up
 *   - operator-side approval (with witnessing-collective provisioning)
 *
 * Endpoints remain mounted (per additive-only stability) but now
 * return 410 Gone with a JSON body pointing at the new path. The
 * OpenAPI spec marks both as `deprecated: true`.
 *
 * Per docs/onboarding-redesign.md §4 and CHANGELOG 2026-05-19.
 */

import { Router } from 'express';

const router: ReturnType<typeof Router> = Router();

const RETIRED_RESPONSE = {
  error: {
    code: 'ENDPOINT_RETIRED',
    message:
      "Self-service registration moved to the developer portal at https://neighborhood-commons.org/developers/sign-up. The legacy POST flow is retired; the new path is a guided sign-up with magic-link login, MFA, and an operator review step. If you're running pre-3.1 tooling against this endpoint, swap to the portal — your existing service key continues to work in the meantime.",
  },
};

router.post('/send-otp', (_req, res) => {
  res.status(410).json(RETIRED_RESPONSE);
});

router.post('/verify-otp', (_req, res) => {
  res.status(410).json(RETIRED_RESPONSE);
});

export default router;
