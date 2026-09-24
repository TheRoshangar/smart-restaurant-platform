# One image: the API and the built web app (served by the same process).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY frontend/package*.json frontend/
RUN npm --prefix frontend ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/db/migrations ./dist/db/migrations
COPY --from=build /app/frontend/dist ./frontend/dist
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
