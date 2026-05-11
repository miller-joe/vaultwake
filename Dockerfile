### Build stage ##############################################################
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

### Runtime stage ############################################################
FROM node:20-alpine AS runtime

# docker-cli + the compose v2 plugin so vaultwake can shell out to
# `docker compose down/up -d` against the host's mounted /var/run/docker.sock.
# tini gives us proper signal forwarding.
RUN apk add --no-cache docker-cli docker-cli-compose tini

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY package.json README.md LICENSE ./

VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/dist/server.js"]
