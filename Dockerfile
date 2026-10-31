# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.18.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN pnpm prisma:generate

FROM dependencies AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Keep production dependencies and Chromium independent of source-only edits.
FROM dependencies AS production-deps
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.18.3 --activate
ENV COREPACK_HOME=/pnpm/corepack
RUN corepack prepare pnpm@10.18.3 --activate
ENV COREPACK_ENABLE_NETWORK=0
WORKDIR /app
COPY --from=production-deps /app/package.json /app/pnpm-lock.yaml ./
COPY --from=production-deps /app/node_modules ./node_modules
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
# The production seed imports the canonical platform catalog from src. Keep
# that small source tree available so `pnpm prisma:seed` works inside the API
# container after migrations without duplicating catalog data.
COPY --from=build /app/src ./src
COPY scripts/parse-account-upload.py scripts/read-social-accounts.py ./scripts/
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
