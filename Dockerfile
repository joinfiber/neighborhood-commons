# Fiber Commons API — Standalone Docker Build
# No monorepo workspace dependency — self-contained Node.js app

FROM node:20-alpine AS base
WORKDIR /app

# Install all dependencies
# sharp prebuilt binary resolution fails on Alpine npm, so we:
# 1. Install without running scripts (skips sharp's broken check)
# 2. Explicitly install the musl prebuilt binary sharp needs
FROM base AS deps
COPY package.json ./
RUN npm install --ignore-scripts && \
    npm install @img/sharp-linuxmusl-x64 --no-save --ignore-scripts

# Build TypeScript
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN ls -la dist/ && test -f dist/index.js

# Production image
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy node_modules (sharp musl binary included), then prune dev deps
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN npm prune --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S fiber -u 1001
USER fiber

EXPOSE 3001
CMD ["node", "dist/index.js"]
