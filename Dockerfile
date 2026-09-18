# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS dependencies

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci \
    && npx playwright install --with-deps chromium

FROM dependencies AS builder

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src

RUN npm run build

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3315 \
    PLAYWRIGHT_HEADLESS=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev \
    && mkdir -p /app/storage \
    && chown -R node:node /app

COPY --from=dependencies /ms-playwright /ms-playwright
COPY --from=builder /app/dist ./dist

RUN chown -R node:node /ms-playwright

USER node

EXPOSE 3315

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3315/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
