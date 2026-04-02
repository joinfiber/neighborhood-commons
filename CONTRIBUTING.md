# Contributing to Neighborhood Commons

Thanks for your interest in contributing. This project is open infrastructure for neighborhood event data — every improvement benefits every app that builds on it.

## Getting Started

1. **Read [CLAUDE.md](CLAUDE.md)** — the full development guide. It covers architecture, security rules, testing philosophy, and the spec relationship. Everything you need to write code that fits.

2. **Set up locally:**
   ```bash
   git clone https://github.com/joinfiber/neighborhood-commons.git
   cd neighborhood-commons
   npm install
   cp .env.example .env  # fill in your Supabase credentials
   npm run dev
   ```

3. **Run tests before pushing:**
   ```bash
   npm run test:run
   ```

## What We Value

- **Spec fidelity.** We implement the [Neighborhood API](https://github.com/The-Relational-Technology-Project/neighborhood-api) spec faithfully. Don't deviate from it in public endpoints.
- **Security by default.** Every input validated. Every table has RLS. Every image re-encoded. No shortcuts.
- **Fewer things, done completely.** One approach per concern, fully implemented. Don't add a feature unless you're willing to own its edge cases.
- **Tests that find real bugs.** If a test can't fail in a way that matters, it doesn't belong. See CLAUDE.md for what to test when.

## Making Changes

- **Bug fix?** Open a PR with a clear description of what broke and how you fixed it.
- **New feature?** Open an issue first to discuss. The commons is deliberately thin — most features belong in consuming apps, not here.
- **Spec change?** Contribute upstream to the [Neighborhood API spec](https://github.com/The-Relational-Technology-Project/neighborhood-api), then we adopt it.

## Code Style

- TypeScript with strict mode. No `any`.
- Files: `kebab-case.ts`. Functions: `camelCase`. Constants: `UPPER_SNAKE_CASE`.
- No ORMs, no DI containers, no "utility" libraries. Keep the dependency tree small.
- Comments explain *why*, not *what*.

## License

Code contributions are MIT-licensed. Event data is CC BY 4.0.
