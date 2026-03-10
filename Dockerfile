# Fiber Commons API — Standalone Docker Build
# No monorepo workspace dependency — self-contained Node.js app

FROM node:20-alpine AS base
WORKDIR /app

# Install all dependencies (sharp needs build tools for native bindings)
FROM base AS deps
RUN apk add --no-cache python3 make g++ vips-dev
RUN npm install -g node-gyp
COPY package.json ./
RUN npm install

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

# sharp requires vips at runtime
RUN apk add --no-cache vips

# Copy node_modules from deps (sharp already compiled), then prune dev deps
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN npm prune --omit=dev

COPY --from=builder /app/dist ./dist

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S fiber -u 1001
USER fiber

EXPOSE 3001
CMD ["node", "dist/index.js"]
