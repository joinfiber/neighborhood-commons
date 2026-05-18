# Stability Promise — What Breaks vs. What Doesn't

**Status:** Operational doctrine. Anyone proposing a change to the Spec tests it against this document before opening a PR.

## The promise, in one sentence

From 3.0 onward, the Neighborhood Commons Spec is **additive-only**. Existing fields, types, and behaviors don't change. New things appear additively. Breaking changes require a new major version and very strong justification, measured in years.

The deepest value the Commons offers is *time*: certainty that what works today still works in eighteen months. That promise is more valuable than any individual feature addition. Most proposed changes test against this doc and fail; that is the doc working correctly.

## Why pre-launch was different

The 2.0.0 draft existed but no external consumer had built against it. Mid-flight model fixes (the four-role provenance frame, the standard `method` vocabulary) were possible without violating any promise to anyone. **That window is closed at 3.0.** From here, the Commons accepts the constraints of being a published contract.

## The taxonomy

### Breaking changes (require a new major)

A change is **breaking** if a correct consumer built against the previous version can be broken by it. Concretely:

1. **Removing a field from a response shape.** Even if the field was always null, even if it seemed unused — removing it breaks consumers who reference it.
2. **Renaming a field.** Same impact as removal plus addition.
3. **Changing a field's type** (e.g., string → number, object → array, scalar → null).
4. **Narrowing an enum's accepted values.** Consumers may switch-case on the values.
5. **Tightening a validation rule.** A request that succeeded before now fails (e.g., a `maxLength` shrinks, a previously-optional field becomes required).
6. **Removing or renaming an endpoint, parameter, header, or error code.**
7. **Changing an endpoint's response status code semantics.** E.g., changing a 200-with-empty-body into a 204.
8. **Changing the meaning of an existing field** without changing its name or type. The most insidious form — "this column now means X, where it used to mean Y." Counts as breaking even with no syntactic diff.
9. **Increasing the privilege required** to call an endpoint (e.g., something that worked with a developer-tier key now needs service-tier).
10. **Increasing rate-limit strictness** beyond what consumers can reasonably adapt to in a short window. (Loosening is fine.)

### Additive changes (allowed any time)

A change is **additive** if it cannot break a correct consumer:

1. **New optional fields on a response.** Consumers ignore what they don't read.
2. **New endpoints.** Consumers that don't call them aren't affected.
3. **New query parameters with safe defaults.** Default behavior unchanged for callers who omit them.
4. **New error codes returned only in new conditions.** Consumers' existing code paths don't see them.
5. **New enum values on a response field.** Consumers should treat unknown enum values defensively. (We document this expectation in [`docs/four-roles.md`](four-roles.md) and the Source schema description.)
6. **Loosening a validation rule.** Requests that used to fail now succeed.
7. **Loosening a rate limit.**
8. **New optional headers** that the server interprets.
9. **New primitives** (a future `Classified` type, etc.) that don't replace existing ones.
10. **Internal refactors** with no observable behavior change.

### Gray areas (case-by-case, lean conservative)

These can go either way depending on consumer expectations:

- **Adding a new enum value to a *request* field.** Strictly speaking additive, but if a consumer's input validation mirrors the spec, they may reject the new value. Generally treated as additive but worth a CHANGELOG callout.
- **New required fields on a *request* shape.** Breaking for consumers whose payloads omit it. We do not do this without a major version.
- **Tightening a content-type contract** (e.g., the server now requires `application/json` where it previously accepted anything). Treated as breaking.
- **Behavioral changes that "fix bugs" but were relied upon.** Bug fixes are usually fine, but if consumers built around the buggy behavior, the fix is breaking for them. Lean toward calling them out as breaking when in doubt.

## What "broken" means in practice

A consumer is "broken" if:

- Their build fails after upgrading the SDK with no code changes (a type-level regression).
- Their requests start returning errors that they were not seeing before.
- Their responses start failing the validators they had in place.
- A previously-working tap-through, surface, or rendering breaks visually because a field they relied on disappears.

A consumer is **not** "broken" if:

- They were relying on a field that openapi.json never declared (their fault, not ours).
- They were relying on a value the server happens to return but the spec described as optional.
- They are running against a newer server with an older SDK and not updating.

## Process — what runs at every PR

Before merging any PR that touches `public/openapi.json` or response-producing code:

1. **Diff the spec.** What fields, endpoints, error codes, validation rules, or enums changed?
2. **Classify each change** against the taxonomy above.
3. **If any classification is "breaking,"** the PR cannot land on the current major. Either redesign as additive (most common — usually a new field/endpoint instead of a modified one), or defer to a future major release.
4. **If all changes are additive,** the PR may merge with a CHANGELOG entry describing the additions.
5. **If gray-area,** ask for a second pair of eyes and lean conservative.

CI enforces the easy half of this:

- `tests/contract-drift.test.ts` confirms the SDK schema matches `public/openapi.json`. Drift is caught.
- `tests/response-shape-conformance.test.ts` confirms the live transform output matches the spec's declared shape. Drift is caught.
- `tests/schema-alignment.test.ts` confirms code references only existing DB columns. Silent column drift is caught.

The human-judgement half — *is this change breaking?* — is what this doc exists for.

## Versioning

Per [`sdk/RELEASING.md`](../sdk/RELEASING.md), the SDK follows semver tied to the Spec:

| Bump | Cause | Frequency |
|------|-------|-----------|
| Patch | SDK bug fix, no spec change | As needed |
| Minor | Additive spec change (new optional field, endpoint, parameter, enum value) | Rare — weeks to months |
| Major | Breaking spec change (per taxonomy above) | Vanishingly rare — years |

Internal changes (refactors, performance work, security fixes that don't change the contract) don't bump version — they ship in patch releases at most.

## What this doctrine forbids

- "Just one quick rename" — there's no such thing within a major version.
- "It was always wrong; we're fixing it" — bug or not, if it changes the contract, it bumps the major.
- "No one uses that field anyway" — we don't know who's using it; the spec said it was there.
- Sneaking a tightening into a "documentation update" commit.

## What this doctrine permits

- Saying "no" to feature requests that would force breaking. Default "no" on additions; default "wait" on breaking.
- Bundling breaking changes into rare, deliberate major releases that justify the disruption with substantial coherent improvements.
- Internal deprecation tracking — a field can be marked deprecated in the spec's description while still being emitted, signaling consumers to migrate before the next major.

## Related docs

- [`provenance.md`](provenance.md) — type-general doctrine for the `method` field.
- [`four-roles.md`](four-roles.md) — event-specific provenance.
- [`sdk/RELEASING.md`](../sdk/RELEASING.md) — release process.
- [`CHANGELOG.md`](../CHANGELOG.md) — the Log, part of the Commons Contract.
- [`public/openapi.json`](../public/openapi.json) — the Spec, the authoritative artifact.
