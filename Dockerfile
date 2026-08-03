# Dependencies # --------------------------------------------------------------------------------------------------------------

FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/storage/package.json packages/storage/
RUN npm ci --no-audit --no-fund

# Build # ---------------------------------------------------------------------------------------------------------------------

FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN mkdir -p apps/web/public && npm run build -w @quoteredy/web

# Runtime # -------------------------------------------------------------------------------------------------------------------

# Plain Alpine with the apk Node.js runtime: the standalone server needs no
# npm/yarn/corepack, so this drops ~100 MB versus the node:24-alpine base.
FROM alpine:3.22 AS runner
WORKDIR /app
# Chromium powers the server-side PDF export of detailed reports. It always
# runs headless with --disable-gpu (see apps/web/lib/pdf.ts), so Mesa's
# software-GL stack (LLVM + gallium, ~300 MB) is never loaded and can go.
RUN apk add --no-cache nodejs chromium nss freetype harfbuzz ca-certificates ttf-dejavu \
    && rm -rf /usr/lib/libLLVM* /usr/lib/gallium-pipe /usr/lib/libgallium-* \
    && adduser -D -u 1000 -h /home/quoteredy quoteredy
# Without a passwd entry the unprivileged uid inherits HOME=/, which is not
# writable: Chromium then starts its crashpad handler without a database
# directory and aborts. apps/web/lib/pdf.ts additionally pins every Chromium
# directory to a private temp profile.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/home/quoteredy \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY --from=builder --chown=1000:1000 /app/apps/web/.next/standalone ./
COPY --from=builder --chown=1000:1000 /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=1000:1000 /app/apps/web/public ./apps/web/public

USER quoteredy
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
