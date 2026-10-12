# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
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
COPY prisma ./prisma
RUN pnpm prisma:generate
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.18.3 --activate
ENV COREPACK_HOME=/pnpm/corepack
RUN corepack prepare pnpm@10.18.3 --activate
ENV COREPACK_ENABLE_NETWORK=0
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
# The production seed imports the canonical platform catalog from src. Keep
# that small source tree available so `pnpm prisma:seed` works inside the API
# container after migrations without duplicating catalog data.
COPY --from=build /app/src ./src
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
