# Nothing BOT worker: Node + system Chromium for whatsapp-web.js.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium \
    WWEBJS_DATA=/data/wwebjs \
    NODE_ENV=production

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @spot/worker...

COPY packages/shared packages/shared
COPY apps/worker apps/worker

WORKDIR /app/apps/worker
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
