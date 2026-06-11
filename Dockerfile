# Neighborhood Commons — Standalone Docker Build
#
# Single-image build for the Express API + the server-rendered homepage.
# The Portal SPA was retired in PR #41; the build is now one stage simpler.

FROM node:20-alpine AS base
WORKDIR /app

# ─── API: Production dependencies ─────────────────────────────
# sharp 0.34.5 ships prebuilt @img/* packages via optionalDependencies. On
# Alpine/musl we install BOTH the native binding AND its matching libvips
# shared library, pinned to the versions sharp resolves in package-lock.json.
# The binding alone is not enough: at runtime it dlopen's libvips-cpp.so from
# @img/sharp-libvips-linuxmusl-x64, so omitting that package — or letting an
# unpinned `npm install @img/sharp-linuxmusl-x64` drift to a newer binding
# whose libvips isn't present — fails the deploy with ERR_DLOPEN_FAILED.
# Bump both versions whenever `sharp` is bumped in package.json.
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm install --no-save --ignore-scripts \
      @img/sharp-libvips-linuxmusl-x64@1.2.4 \
      @img/sharp-linuxmusl-x64@0.34.5

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
