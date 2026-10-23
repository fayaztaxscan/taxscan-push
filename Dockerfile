# Production image for Railway (builder: Dockerfile).
#
# Why a Dockerfile and not Nixpacks: Nixpacks takes Node from a pinned nixpkgs
# snapshot, so `engines: 24.x` gave 24.10.0 and could not pick up the
# 2026-10-21 security release (fixed in 24.22.1). Pinning the official image
# here makes the runtime an exact, reviewable version. Bump the tag below for
# each Node security release; keep `engines` in package.json on the same line.
FROM node:24.22.1-bookworm-slim

# Prisma's query engine needs OpenSSL; CA certificates for outbound HTTPS
# (Elastic, R2, Mailercloud, Google, web-push).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install with devDependencies: the build needs typescript, @types/* and the
# admin's vite / vue-tsc. `prisma` (a runtime dependency) runs the migrations
# at start. Copy the manifests first so the install layer caches.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
# Railway provides PORT; /healthz is the healthcheck (set in service settings).
# `npm start` = `prisma migrate deploy && node dist/index.js`, same as before.
CMD ["npm", "start"]
