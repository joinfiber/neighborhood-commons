# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Neighborhood Commons, please report it responsibly. **Do not open a public GitHub issue.**

Email **hi@neighborhood-commons.org** with:

- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix (optional but appreciated)

We will acknowledge receipt within 48 hours and aim to provide a substantive response within 5 business days.

## Scope

The following are in scope:

- The Neighborhood Commons API (`api.neighborhood-commons.org`)
- The contributor portal
- Authentication and authorization mechanisms
- Data exposure or privacy violations
- Row Level Security policy bypasses

The following are **out of scope**:

- Denial of service attacks
- Social engineering
- Issues in third-party dependencies with no demonstrated exploit path
- Rate limiting thresholds (these are documented and intentional)

## Security Design

Neighborhood Commons is designed with defense-in-depth:

- **Row Level Security** on every database table, with default-deny for server-only tables
- **Zod validation** on every input before use
- **Image re-encoding** through Sharp on every upload (strips metadata, kills polyglot payloads)
- **SSRF protection** on all user-supplied URLs (DNS resolution + RFC 1918 block + cloud metadata block)
- **Timing-safe comparisons** for all secret values
- **No secrets in logs or error responses** (IDs hashed, emails masked, stack traces stripped)
- **Four clearly separated auth models** with explicit rate limits per route

See [CLAUDE.md](CLAUDE.md) for the full security architecture documentation.

## Supported Versions

Only the latest version deployed to production is supported.
