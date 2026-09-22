# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    PORT=4002

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./package.json
COPY --chown=bun:bun src/application ./src/application
COPY --chown=bun:bun src/domain ./src/domain
COPY --chown=bun:bun src/http ./src/http
COPY --chown=bun:bun src/infrastructure ./src/infrastructure
COPY --chown=bun:bun src/config.ts src/main.ts ./src/
COPY --chown=bun:bun migrations ./migrations

USER bun
EXPOSE 4002
HEALTHCHECK --interval=5s --timeout=2s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const port=Bun.env.PORT??'4002';const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),1000);try{const response=await fetch('http://127.0.0.1:'+port+'/health/ready',{signal:controller.signal});process.exit(response.ok?0:1)}catch{process.exit(1)}finally{clearTimeout(timeout)}"]

ENTRYPOINT []
CMD ["bun", "src/main.ts"]

FROM runtime AS provider
COPY --chown=bun:bun src/dev ./src/dev
HEALTHCHECK NONE
EXPOSE 4003
CMD ["bun", "src/dev/provider.ts"]

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS quality
COPY tsconfig.json ./
COPY Dockerfile .dockerignore compose.yml ./
COPY src ./src
COPY tests ./tests
COPY migrations ./migrations
RUN bun run typecheck
RUN bun test
