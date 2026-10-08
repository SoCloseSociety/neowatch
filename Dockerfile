# NEOWATCH -- one image: builds the web app, then runs the Express server, which serves
# the static bundle + /api on $PORT (8787). Three stages so the runtime image holds the
# server's production dependencies only (no vite/typescript/tailwind) and runs as `node`.
# Node 20 matches production (undici must stay on major 6, see server/package.json).

FROM node:20-alpine AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY web ./web
RUN npm run build

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server/package.json server/
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
# State dirs owned by `node` BEFORE the volumes mount on them (a fresh named volume copies
# this ownership; created later by Docker they would be root-owned and writes would fail).
RUN mkdir -p server/.data server/.cache && chown -R node:node server/.data server/.cache
USER node
EXPOSE 8787
# /api/health answers 503 when the catalog is empty or too old; the grace covers warm-up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8787}/api/health" >/dev/null || exit 1
CMD ["node", "server/src/index.js"]
