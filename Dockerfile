# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# builder — full toolchain, discarded afterwards
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app

# Dependencies first: this layer is cached until package*.json actually change,
# which is what keeps rebuilds off the network.
COPY package.json package-lock.json ./
# devDependencies are required here — nest build and the Prisma generator are
# both dev-only. `prepare` is `husky || true`, so the missing .git is harmless.
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./
# src/generated is gitignored and .dockerignore'd, so the client has to be
# generated inside the build. Without this, tsc cannot resolve the imports and
# the build fails rather than shipping something stale.
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Rebuild node_modules with production dependencies only, in the builder, so the
# runner stage never needs npm to reach the network.
#
# `--omit=peer` is load-bearing, not tidiness. @prisma/client@7 declares `prisma`
# and `typescript` as *optional* peers, and npm installs optional peers anyway —
# dragging in the Prisma CLI and, through it, Prisma Studio's whole front end
# (effect, @electric-sql, react-dom, elkjs). That is ~350 MB of build tooling in
# a runtime image. The generated client's only real dependency is
# @prisma/client-runtime-utils, so omitting the peers is safe; the Prisma smoke
# test in CI is what keeps that claim honest.
RUN npm ci --omit=dev --omit=peer && npm cache clean --force

# npm keeps the Prisma CLI regardless of --omit: @prisma/client@7 declares
# `prisma` and `typescript` as *optional* peers, and an optional peer of a
# production dependency survives both --omit=dev and --omit=peer. The CLI then
# drags Prisma Studio's front end (effect, @electric-sql, react-dom, elkjs) and
# the legacy binary engines along with it — around 200 MB of build tooling
# sitting in a runtime image.
#
# None of it is reachable at runtime. Driver adapters replaced the binary
# engines, `migrate deploy` runs in CI rather than from this image, and nothing
# under dist/ imports the CLI. Removing the trees explicitly is the only way to
# get them out; the Prisma smoke test below is what stops that from being a
# claim nobody checks.
RUN rm -rf \
      node_modules/prisma \
      node_modules/typescript \
      node_modules/@prisma/studio-core \
      node_modules/@prisma/engines \
      node_modules/@prisma/fetch-engine \
      node_modules/@prisma/dev \
      node_modules/effect \
      node_modules/@electric-sql \
      node_modules/react-dom \
      node_modules/react \
      node_modules/elkjs

# The query compiler ships as base64-encoded WebAssembly, one pair of files per
# database provider per size variant, in both CJS and ESM. This project uses
# PostgreSQL and Nest compiles to CommonJS, so four fifths of that is dead
# weight. Deleting by provider name rather than by size variant keeps whichever
# of fast/small the runtime decides to load.
RUN find node_modules/@prisma/client/runtime -name 'query_compiler_*_bg.*' \
      ! -name '*.postgresql.*' -delete

# ---------------------------------------------------------------------------
# runner — runtime only
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app

# No Prisma engine binary to match against musl: this project talks to
# PostgreSQL through @prisma/adapter-pg, which is pure JavaScript. That is the
# only reason alpine works here without openssl compatibility shims.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Tiny, and it is what proves the aggressive prune above did not break the
# Prisma runtime. CI runs it against an ephemeral database after every build.
COPY --chown=node:node scripts ./scripts

# prisma/ is deliberately absent, and so is the Prisma CLI. `migrate deploy`
# runs as a CI step against the repository checkout, not from this image:
# prisma.config.ts is TypeScript, so running the CLI here would mean dragging
# ts-node and the whole dev toolchain into a production image. Schema changes
# are a deploy step, not an application start-up side effect — which is also
# what keeps two replicas from racing each other to migrate.

# The node:alpine image ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 3000

# No shell: exec form makes node PID 1, so it receives SIGTERM directly and the
# container stops on the first signal rather than after the 10s kill timeout.
CMD ["node", "dist/main"]
