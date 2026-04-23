# Releasing the SDK

The `neighborhood-commons` npm package is the embodiment of the Commons Contract. Releasing it well is the difference between an ecosystem that compounds value over time and one that drowns in churn.

## The First Principle

**The Commons spec is additive-only by intent.** It grows over time as new shapes are needed, but existing shapes essentially never change or get removed. Removal almost never happens because addition is done carefully — only when there's a clear and pressing use case.

Every release should be measured against this principle:

- A *patch* release fixes a bug in the SDK without changing the spec.
- A *minor* release adds something to the spec. **This should be uncommon.** Default to "no" on additions; default to "wait" if unsure.
- A *major* release is a breaking change. **This should be vanishingly rare** — measured in years, not months. Reserve majors for genuine defects: security issues, fundamental modeling mistakes, external system shifts.

## When to bump

| Change | Bump | Frequency |
|--------|------|-----------|
| SDK bugfix (no spec change) | patch (0.0.x → 0.0.y) | as needed |
| Add an optional field, new endpoint, new query param, new enum value | minor (0.x.0 → 0.y.0) | rarely — weeks to months |
| Remove a field, rename a field, change a field's type, change required-ness, remove an endpoint | major (x.0.0 → y.0.0) | exceptionally rarely — measured in years |
| Mark a field deprecated (no removal yet) | minor — deprecation is itself an additive change | rarely |

## How to release

1. Edit `sdk/package.json` to bump the `version` field.
2. Add a `CHANGELOG.md` entry for the version. Be terse and factual.
3. Commit. Push to a branch and open a PR. Get it reviewed and merged to `master`.
4. After merge, tag the release commit:
   ```bash
   git checkout master && git pull
   git tag sdk-v0.1.0
   git push origin sdk-v0.1.0
   ```
5. The GitHub Actions workflow (`.github/workflows/sdk-publish.yml`) regenerates the SDK from the master `openapi.json`, builds, and publishes to npm with provenance.
6. Verify: `npm view neighborhood-commons` should show the new version within a minute.

## Adding a field — the disciplined process

Before you add a field to the spec, ask:

1. **Is this a passing need or a real one?** Will three different consumers need this in 12 months, or is one consumer's edge case driving it? If the latter, the consumer should solve it in their own layer.
2. **Will this field hold up for years?** A field added today is something we'll be supporting in 2030. Prefer fewer, more general fields over many specific ones.
3. **Does this field's name match the spec's existing vocabulary?** If you're tempted to invent a new naming convention, stop and align with what's already there.
4. **Is the field nullable?** New fields should always be optional and nullable so they're additive (existing consumers don't break by being unaware of them).
5. **Have you written down the meaning?** A field with an unclear or absent description is a future drift vector. The description in `openapi.json` is the canonical contract — write it carefully.

If the answer to all five is yes, proceed. If any are no, hold the change.

## Deprecating a field — the multi-version journey

Even fields we want to remove should be removed slowly. The cycle:

1. **Mark `deprecated: true`** in the spec for the field. Add a `description` explaining what to use instead and from when. Bump minor version.
2. **Wait at least 2 minor versions.** Watch consumer adoption (`scripts/sdk-health.ts` reports version distribution). Encourage migration via CHANGELOG notes, not enforcement.
3. **Remove only after deprecation has soaked.** Bump major version. Document loudly in CHANGELOG with a `BREAKING:` prefix.

A field that was added thoughtfully will rarely need deprecation. If you find yourself deprecating frequently, the upstream issue is the addition discipline, not the deprecation policy.

## What gets a CHANGELOG entry

Every release. Always. The CHANGELOG is part of the Commons Contract — consumers watch it (or diff it on each release) to know what changed. Format is documented in `CHANGELOG.md` itself.

Patch releases that only fix SDK bugs (no spec change) still get an entry under the date, prefixed with the SDK version.

## What doesn't go in the SDK

The SDK is a thin generated client plus a minimal wrapper. Resist the urge to add:

- Convenience methods like `commons.events.list()` (consumers can use the typed `commons.GET("/events", ...)` directly)
- Retry logic, caching, debouncing
- "Smart" defaults that the spec doesn't require
- Authentication helpers beyond the existing `apiKey` option
- Type aliases beyond the small set already exported

If a wrapper feature seems compelling, the bar is **"consumers genuinely cannot easily do this themselves."** Almost nothing meets that bar. When in doubt: propose it as a spec change first, or implement it in a separate package.

## The conscience of the spec

Every spec change ripples through the SDK to every consumer's `npm update`. That cost is the feature, not the bug — it forces deliberation. If you're tempted to "just tweak" the spec without going through this process, you're tempted to drift the ecosystem. Don't.

The Commons is most valuable when consumers can build against it today and have their code still work in 18 months. The SDK release process exists to protect that promise.
