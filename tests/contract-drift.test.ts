/**
 * Contract drift guards — Neighborhood Commons
 *
 * Three mechanical checks to prevent the three most likely drift vectors
 * from creeping back in:
 *
 *   1. Middleware error shape — every error in src/middleware/* must flow
 *      through next(createError(...)), never res.status().json(). One shape,
 *      one place. error-handler.ts is the only exception (it IS the shape).
 *
 *   2. ErrorCode enum coverage — every string code thrown via createError()
 *      must be listed in openapi.json's ErrorCode enum. Keeps the Spec
 *      honest about what error codes consumers can expect.
 *
 *   3. OpenAPI route coverage — every router.METHOD('/path') declared in
 *      in-contract route files must have a matching entry in openapi.json
 *      paths. Out-of-contract surfaces (portal, admin, cron, places, pages,
 *      dev-only) are explicitly not checked.
 *
 * These run as part of the regular test suite — no new CI step, no new
 * script, no custom ESLint plugin. A contract-affecting change that forgets
 * to update openapi.json or the ErrorCode enum fails the build.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const repoRoot = resolve(__dirname, '..');
const srcDir = join(repoRoot, 'src');
const routesDir = join(srcDir, 'routes');
const middlewareDir = join(srcDir, 'middleware');
const openapiPath = join(repoRoot, 'public', 'openapi.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively list all .ts files under a directory (excluding node_modules and dist). */
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...getAllTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Guard 1: middleware uses next(createError()), not res.status().json()
// ---------------------------------------------------------------------------

describe('contract drift: middleware error shape', () => {
  // error-handler.ts is the ONE file that legitimately calls res.status().json()
  // because it's the implementation of the shape itself.
  const EXEMPT = new Set(['error-handler.ts']);

  it('no middleware file (except error-handler.ts) uses res.status().json()', () => {
    const files = readdirSync(middlewareDir).filter(f => f.endsWith('.ts'));
    const violations: string[] = [];

    for (const file of files) {
      if (EXEMPT.has(file)) continue;
      const content = readFileSync(join(middlewareDir, file), 'utf-8');
      content.split('\n').forEach((line, i) => {
        if (/res\.status\([^)]*\)\.json\(/.test(line)) {
          violations.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      violations,
      `Middleware must use next(createError(...)) for errors — one error shape per CLAUDE.md.\nFound direct res.status().json() calls:\n${violations.map(v => '  ' + v).join('\n')}\n\nFix: import { createError } from './error-handler.js'; then replace\n  res.status(403).json({ error: { code: 'X', message: 'Y' } })\nwith\n  return next(createError('Y', 403, 'X'));\n`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard 2: every createError code is in the OpenAPI ErrorCode enum
// ---------------------------------------------------------------------------

describe('contract drift: ErrorCode enum coverage', () => {
  it('every code thrown via createError() in src/ is listed in openapi.json ErrorCode enum', () => {
    const spec = JSON.parse(readFileSync(openapiPath, 'utf-8'));
    const enumCodes: string[] = spec.components?.schemas?.ErrorCode?.enum ?? [];
    expect(enumCodes.length, 'openapi.json is missing components.schemas.ErrorCode.enum').toBeGreaterThan(0);
    const enumSet = new Set(enumCodes);

    const foundCodes = new Set<string>();
    for (const file of getAllTsFiles(srcDir)) {
      const content = readFileSync(file, 'utf-8');
      // Match createError('msg', 400, 'CODE') across one or many lines.
      // The regex tolerates multi-line, whitespace, and trailing commas.
      const pattern = /createError\([^)]*?['"]([A-Z_]+)['"]\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        foundCodes.add(m[1]);
      }
    }

    const missing = [...foundCodes].filter(c => !enumSet.has(c)).sort();
    expect(
      missing,
      `Codes thrown in src/ but not in openapi.json ErrorCode enum:\n${missing.map(c => '  ' + c).join('\n')}\n\nFix: add each missing code to public/openapi.json → components.schemas.ErrorCode.enum (alphabetical) and update the description groupings.\n`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard 3: every in-contract route is documented in openapi.json
// ---------------------------------------------------------------------------

describe('contract drift: in-contract routes documented in openapi.json', () => {
  // Route file (relative to src/routes/) → path suffix to append to the spec's
  // default server base URL. The spec's server URL is https://.../api/v1, so
  // paths documented in the spec are relative to /api/v1 (e.g. "/service/events"
  // in the spec is /api/v1/service/events at the Express level).
  //
  // Out-of-contract files (portal/*, admin/*, cron.ts, places.ts, pages.ts,
  // internal.ts) are intentionally omitted. public.ts mostly handles
  // redirects + /events/changes (which lives outside /v1 via a per-path
  // server override in the spec) — also omitted.
  //
  // If you add a new in-contract route file, register it here.
  const IN_CONTRACT_ROUTES: Record<string, string> = {
    'v1.ts': '/events',
    'v1-groups.ts': '/groups',
    'v1-accounts.ts': '/accounts',
    'webhooks.ts': '/webhooks',
    'meta.ts': '/meta',
    'developers.ts': '/developers',
    'contribute.ts': '/contribute',
    'service/accounts.ts': '/service',
    'service/events.ts': '/service',
    'service/series.ts': '/service',
    'service/images.ts': '/service',
    'service/groups.ts': '/service',
    'service/admin-ops.ts': '/service',
  };

  it('every in-contract router.METHOD call is in openapi.json paths', () => {
    const spec = JSON.parse(readFileSync(openapiPath, 'utf-8'));
    const specPaths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;

    const violations: string[] = [];

    for (const [relFile, prefix] of Object.entries(IN_CONTRACT_ROUTES)) {
      const filePath = join(routesDir, ...relFile.split('/'));
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        violations.push(`[file missing] ${relFile} — remove from IN_CONTRACT_ROUTES or restore the file`);
        continue;
      }

      const pattern = /router\.(get|post|patch|put|delete)\(\s*['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const method = m[1];
        const relativePath = m[2];
        // Compose the spec-relative path (no /api/v1 — that's the server base URL)
        const composedPath = relativePath === '/' ? prefix : prefix + relativePath;
        // Express :param → OpenAPI {param}
        const openapiPath = composedPath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');

        if (!specPaths[openapiPath] || !specPaths[openapiPath][method]) {
          violations.push(`${relFile}  ${method.toUpperCase()} ${openapiPath}`);
        }
      }
    }

    expect(
      violations,
      `In-contract routes missing from openapi.json:\n${violations.map(v => '  ' + v).join('\n')}\n\nFix: add the route to public/openapi.json → paths, or — if it's truly out-of-contract — move the handler to a non-listed route file (portal/*, admin/*, etc.) and remove it from IN_CONTRACT_ROUTES in this test.\n`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. SDK schema is in sync with the spec
// ---------------------------------------------------------------------------
//
// `sdk/src/generated/schema.ts` is committed to the repo and published to
// npm as the `neighborhood-commons` package. It MUST be the exact output of
// running openapi-typescript against the current public/openapi.json. A
// spec edit without a matching SDK regen is silent drift — consumers on
// `npm update` would still see the old types until someone notices.
//
// This test re-runs openapi-typescript against the spec and compares the
// fresh output against the committed file. Any difference fails the build
// with a one-line fix: cd sdk && npm run generate.

describe('SDK schema regeneration', () => {
  it('sdk/src/generated/schema.ts is up-to-date with public/openapi.json', () => {
    const sdkSchemaPath = join(repoRoot, 'sdk', 'src', 'generated', 'schema.ts');
    const committed = readFileSync(sdkSchemaPath, 'utf-8');

    let regenerated: string;
    try {
      regenerated = execSync(
        `npx --no-install openapi-typescript "${openapiPath}"`,
        { encoding: 'utf-8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      throw new Error(
        `Failed to run openapi-typescript. Ensure the devDep is installed (run \`npm ci\`).\n${(err as Error).message}`,
      );
    }

    // Normalize line endings — committed file may have CRLF on Windows
    // checkouts, while openapi-typescript writes LF.
    const normalize = (s: string): string => s.replace(/\r\n/g, '\n').trim();

    expect(
      normalize(regenerated),
      `\nSDK schema is stale relative to public/openapi.json.\n\nFix: cd sdk && npm run generate, then commit the updated sdk/src/generated/schema.ts in the same PR as the spec change.\n\nThis guard exists because consumer apps depend on the npm-published SDK; a spec edit without a regen is silent drift that surfaces only when someone notices.\n`,
    ).toBe(normalize(committed));
  });
});
