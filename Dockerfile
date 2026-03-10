# Fiber Commons API — Standalone Docker Build
# No monorepo workspace dependency — self-contained Node.js app

FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json ./
RUN npm install

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN ls -la dist/ && test -f dist/index.js

# Production image
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# sharp requires vips native libraries on Alpine
RUN apk add --no-cache vips-dev

COPY --from=builder /app/package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S fiber -u 1001
USER fiber

EXPOSE 3001
CMD ["node", "dist/index.js"]
