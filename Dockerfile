# Multi-stage build for Next.js + Prisma. Final runtime image is just the
# standalone bundle + .prisma client + public/static — no source, no full
# node_modules. Keeps the Fly.io image well under 200 MB.

# ---------- deps ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Prisma needs OpenSSL at install time so the engine binaries match the
# target glibc. We also need build essentials for native modules.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# ---------- builder ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `prisma generate` emits the typed client into node_modules so the Next
# build can reference it. We disable telemetry to keep build logs clean.
ENV NEXT_TELEMETRY_DISABLED=1
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
RUN npx prisma generate
RUN npm run build

# ---------- runner ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid 1001 --create-home --home-dir /home/nextjs nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Install prisma globally so the release_command `prisma migrate deploy`
# resolves on PATH. The standalone bundle's own node_modules does not
# include the prisma CLI shim, and npx cannot find it in a global cache
# when offline inside the release machine. NODE_PATH points node's module
# resolver at the global node_modules too so `require('prisma/config')`
# from /app/prisma.config.ts can find it.
RUN npm install -g prisma@7
ENV NODE_PATH=/usr/local/lib/node_modules

# Bring over the standalone bundle (includes a minimal node_modules) plus
# the static assets the runtime serves directly, plus the prisma client
# engine binaries so `@prisma/client` works at runtime, plus the
# prisma.config.ts (Prisma 7 requires it for `migrate deploy`).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
