# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/build ./build

# Azure App Service (Linux, custom container) routes traffic to the port named
# by the WEBSITES_PORT app setting; set that app setting to match this PORT.
ENV PORT=3939
EXPOSE 3939

CMD ["node", "build/server/index.js"]
