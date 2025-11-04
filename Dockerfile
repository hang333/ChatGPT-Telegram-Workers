#FROM node:alpine AS DEV
FROM oven/bun:alpine AS DEV

WORKDIR /app

COPY .git ./.git
COPY package.json vite.config.ts tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun install && bun run build:local

#FROM node:alpine AS PROD
FROM oven/bun:alpine AS PROD

WORKDIR /app
COPY --from=DEV /app/dist/index.js /app/dist/index.js
COPY --from=DEV /app/package.json /app/
RUN apk add --no-cache sqlite && \
    bun install -p --omit=dev && \
    bun pm cache rm
EXPOSE 8787
CMD ["bun", "run", "start:dist"]
