# syntax=docker/dockerfile:1

# ---- build: compile TypeScript, then drop dev dependencies ----
FROM node:22.20-alpine3.22 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# ---- runtime: production dependencies + compiled JS, non-root ----
FROM node:22.20-alpine3.22 AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080

# Node handles SIGTERM itself (graceful shutdown in src/server.ts).
CMD ["node", "dist/src/server.js"]
