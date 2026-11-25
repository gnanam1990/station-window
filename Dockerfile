FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/server.ts"]
