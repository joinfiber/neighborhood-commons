# Fiber Commons API — Standalone Docker Build
# No monorepo workspace dependency — self-contained Node.js app

FROM node:20-alpine AS base
WORKDIR /app

# Install production dependencies (with sharp native build support)
FROM base AS deps
RUN apk add --no-cache python3 make g++ vips-dev
COPY package.json ./
RUN npm install --omit=dev

# Install all dependencies for TypeScript build
FROM base AS all-deps
COPY package.json ./
RUN npm install

# Build
FROM base AS builder
COPY --from=all-deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN ls -la dist/ && test -f dist/index.js

# Production image
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# sharp requires vips at runtime
RUN apk add --no-cache vips

# Copy pre-built production node_modules (sharp already compiled)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S fiber -u 1001
USER fiber

EXPOSE 3001
CMD ["node", "dist/index.js"]
