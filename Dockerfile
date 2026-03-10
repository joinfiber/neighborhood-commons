# Fiber Commons API — Standalone Docker Build
# No monorepo workspace dependency — self-contained Node.js app

FROM node:20-alpine AS base
WORKDIR /app

# Production dependencies only (for the final image)
# sharp prebuilt binary resolution fails on Alpine npm, so we
# skip install scripts and explicitly add the musl prebuilt binary
FROM base AS prod-deps
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && \
    npm install @img/sharp-linuxmusl-x64 --ignore-scripts

# All dependencies (for TypeScript compilation)
FROM base AS all-deps
COPY package.json ./
RUN npm install --ignore-scripts

# Build TypeScript
FROM base AS builder
COPY --from=all-deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN ls -la dist/ && test -f dist/index.js

# Production image
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S fiber -u 1001
USER fiber

EXPOSE 3001
CMD ["node", "dist/index.js"]
