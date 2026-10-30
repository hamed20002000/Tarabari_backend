# Tarabari backend (NestJS). Built and run by transport_backend/deploy/docker-compose.yml.
# NPM_REGISTRY, DEBIAN_MIRROR: mirrors when npm or Debian are out of reach from the server
# (e.g. DEBIAN_MIRROR=https://mirror.arvancloud.ir).
FROM node:20.20.2-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG DEBIAN_MIRROR=http://deb.debian.org
WORKDIR /app
# native modules that have no prebuilt binary are compiled here
RUN sed -i "s#http://deb.debian.org#${DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Retries=5 -o Acquire::ForceIPv4=true update && apt-get -o Acquire::Retries=5 -o Acquire::ForceIPv4=true install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# postinstall (patch-package) needs the patches before npm ci
COPY patches ./patches
# IPv4 first (IPv6 hangs on networks without it), patient retries, a cache that survives a failed build; legacy peer
# deps as on the dev machine (@nestjs/passport 10 asks for @nestjs/common 10, the project has 11)
RUN --mount=type=cache,target=/root/.npm NODE_OPTIONS=--dns-result-order=ipv4first npm ci --registry="$NPM_REGISTRY" \
    --legacy-peer-deps --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY . .
RUN npx nest build

FROM node:20.20.2-bookworm-slim
ARG DEBIAN_MIRROR=http://deb.debian.org
# ffmpeg: voice messages of the channels
RUN sed -i "s#http://deb.debian.org#${DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Retries=5 -o Acquire::ForceIPv4=true update && apt-get -o Acquire::Retries=5 -o Acquire::ForceIPv4=true install -y --no-install-recommends ffmpeg ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production TZ=Asia/Tehran
WORKDIR /app
# all dependencies stay (dev ones too): migrations run with ts-node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# read at run time from src/: the agent's JSON files and prompts; and the migrations
COPY --from=build /app/src ./src
COPY package.json tsconfig.json tsconfig.build.json ./
# .env, keys/, cdn/ (files it serves) and uploads come from the machine (volumes), never from the image
RUN mkdir -p uploads keys logs cdn && chown -R node:node /app
USER node
EXPOSE 3001
CMD ["node", "dist/main"]
