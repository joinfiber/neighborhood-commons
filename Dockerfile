# Fiber Commons — Standalone Docker Build
# Builds both the API (Express) and the Portal (React SPA)

FROM node:20-alpine AS base
WORKDIR /app

# ─── API: Production dependencies ─────────────────────────────
# sharp prebuilt binary resolution fails on Alpine npm, so we
# skip install scripts and explicitly add the musl prebuilt binary
FROM base AS prod-deps
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && \
    npm install @img/sharp-linuxmusl-x64 --ignore-scripts

# ─── API: All dependencies (for TypeScript compilation) ───────
FROM base AS all-deps
COPY package.json ./
RUN npm install --ignore-scripts

# ─── API: Build TypeScript ────────────────────────────────────
FROM base AS api-builder
COPY --from=all-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm run build
RUN ls -la dist/ && test -f dist/index.js

# ─── Portal: Build React SPA ─────────────────────────────────
FROM base AS portal-builder
WORKDIR /app/portal
COPY portal/package.json ./
RUN npm install
COPY portal/ .

# Supabase config baked into the SPA at build time
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_TURNSTILE_SITE_KEY
# VITE_API_URL intentionally omitted — same-origin (empty string)

RUN npm run build
RUN ls -la dist/ && test -f dist/index.html

# ─── Production image ─────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=api-builder /app/package.json ./
COPY --from=api-builder /app/dist ./dist
COPY --from=portal-builder /app/portal/dist ./portal
COPY public ./public

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S fiber -u 1001
USER fiber

EXPOSE 3001
CMD ["node", "dist/index.js"]
