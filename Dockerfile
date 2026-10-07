# EvoRace — jogo + servidor do ranking numa imagem só.
# O banco SQLite fica em /data (monte um volume persistente aí).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/evorace.db STATIC_DIR=/app/dist
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/core ./src/core
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "server/main.ts"]
