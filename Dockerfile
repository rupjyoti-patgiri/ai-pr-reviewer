# ───────── Stage 1: Build ─────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ───────── Stage 2: Production ─────────
FROM node:20-alpine AS production

RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY review-config.yaml ./

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

USER appuser

EXPOSE 3000

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]