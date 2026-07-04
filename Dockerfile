# NEOWATCH -- single-image build: builds the web app, then runs the Express server
# which serves the static bundle + the /api routes on $PORT.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Copy installed deps + built artifacts + sources.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json
EXPOSE 8787
CMD ["node", "server/src/index.js"]
