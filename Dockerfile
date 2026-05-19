# Neighborhood Commons — Standalone Docker Build
#
# Single-image build for the Express API + the server-rendered homepage.
# The Portal SPA was retired in PR #41; the build is now one stage simpler.

FROM node:20-alpine AS base
WORKDIR /app

# ─── API: Production dependencies ─────────────────────────────
# sharp prebuilt binary resolution fails on Alpine npm, so we
# skip install scripts and explicitly add the musl prebuilt binary
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm install @img/sharp-linuxmusl-x64 --ignore-scripts

# ─── API: All dependencies (for TypeScript compilation) ───────
FROM base AS all-deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ─── API: Build TypeScript ────────────────────────────────────
FROM base AS api-builder
COPY --from=all-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm run build
RUN ls -la dist/ && test -f dist/index.js

# ─── Production image ─────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=api-builder /app/package.json ./
COPY --from=api-builder /app/dist ./dist
COPY public ./public
# Docs are served by /docs/:slug at runtime via marked. The build context
# whitelists docs/*.md through .dockerignore — see that file for the
# ignore + un-ignore rules.
COPY docs ./docs

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S commons -u 1001
USER commons

EXPOSE 3001
CMD ["node", "dist/index.js"]
