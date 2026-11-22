# The Swellwright container image (ADR 0019): the API and the console in one image. The same image also
# applies the database migrations (`node packages/db/scripts/prisma.mjs migrate deploy`) and runs the
# administration commands (`node apps/api/dist/admin.js`).
#
#   docker build -t swellwright:local .
#
# Everything that is downloaded is pinned: the base image by digest, pnpm by the hash of its tarball, the
# packages by the lockfile (`--frozen-lockfile`, no lifecycle scripts), the Prisma schema engine by the
# checksum in packages/db/engine-checksums.json. Dependabot proposes new digests.

ARG NODE_IMAGE=node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

# The Prisma schema engine is a native program that needs OpenSSL.
FROM ${NODE_IMAGE} AS base
# Where the Prisma schema engine is downloaded from (also during `pnpm run build`, which generates the client).
# The default is Prisma's own host; behind a network that cannot reach it, pass another one with
# `--build-arg PRISMA_ENGINES_MIRROR=<url>`. Whatever the source, the engine is checked against the checksum
# pinned in packages/db/engine-checksums.json, so a mirror cannot swap the binary.
ARG PRISMA_ENGINES_MIRROR=https://binaries.prisma.sh
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# pnpm is installed from the registry tarball, and only if its hash is the one written here
# (see `npm view pnpm@<version> dist.integrity`). Corepack is no longer part of Node.
FROM base AS tooling
ARG PNPM_VERSION=10.34.9
ARG PNPM_INTEGRITY=sha512-9JtajqD97bRLs8DB1ldQkqU8KVDZW3rRXfEfF5dId6LeOgHAfpNOmyjOcW5RwJqUlixzBtCb4uHksYqMh2L9Mg==
ENV CI=true \
    DO_NOT_TRACK=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN set -eu; \
    cd /tmp; \
    npm pack "pnpm@${PNPM_VERSION}" --json > pack.json; \
    node -e "const [p] = JSON.parse(require('node:fs').readFileSync('pack.json', 'utf8')); if (p.integrity !== process.argv[1]) { console.error('pnpm tarball hash mismatch: ' + p.integrity); process.exit(1); }" "${PNPM_INTEGRITY}"; \
    npm install --global --ignore-scripts "/tmp/pnpm-${PNPM_VERSION}.tgz"; \
    rm -f pack.json "pnpm-${PNPM_VERSION}.tgz"

# Only the package.json files of the workspace, so that a change to the source does not repeat the install.
FROM base AS manifests
COPY . /src
RUN mkdir /manifests \
 && cd /src \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents '{}' /manifests ';'

# Everything, with the development tools: builds the packages and the console.
FROM tooling AS build
WORKDIR /app
COPY --from=manifests /manifests ./
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build \
 && find apps packages -path '*/dist/*' -name '*.test.*' -delete \
 && find artifacts -type d -name test -prune -exec rm -rf '{}' +

# The packages the server needs at run time (the console is already built, its framework is not needed).
FROM tooling AS server-deps
WORKDIR /app
COPY --from=manifests /manifests ./
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@swellwright/api..."
# The migration tool: the schema, the checked wrapper and its pins. The engine is fetched and checked now,
# not when the container runs. Fetching it runs `prisma generate`, which writes a client nobody needs here.
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.mjs packages/db/engine-checksums.json packages/db/
COPY packages/db/scripts packages/db/scripts
RUN node packages/db/scripts/prisma.mjs --verify-engine \
 && rm -rf packages/db/src

FROM base AS runtime
ARG SW_VERSION=0.0.0-dev
ARG SW_COMMIT=unknown
# Optional build facts for the console's "Build info" (GET /api/v1/version); empty means "not recorded".
ARG SW_BUILD_TIME=
ARG SW_BUILD_NUMBER=
ARG SW_GIT_BRANCH=
ARG SW_GIT_COMMIT=
LABEL org.opencontainers.image.title="Swellwright" \
      org.opencontainers.image.description="Console and API for deploying and operating Remnawave fleets" \
      org.opencontainers.image.source="https://github.com/swellwright/swellwright" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${SW_VERSION}" \
      org.opencontainers.image.revision="${SW_COMMIT}"
WORKDIR /app
ENV NODE_ENV=production \
    SW_HTTP_HOST=0.0.0.0 \
    SW_HTTP_PORT=3000 \
    SW_WEB_DIR=/app/web \
    SW_VERSION=${SW_VERSION} \
    SW_COMMIT=${SW_COMMIT} \
    SW_BUILD_TIME=${SW_BUILD_TIME} \
    SW_BUILD_NUMBER=${SW_BUILD_NUMBER} \
    SW_GIT_BRANCH=${SW_GIT_BRANCH} \
    SW_GIT_COMMIT=${SW_GIT_COMMIT} \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
COPY --from=server-deps /app ./
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/plugin-api/dist ./packages/plugin-api/dist
COPY --from=build /app/packages/remnawave/dist ./packages/remnawave/dist
COPY --from=build /app/packages/ssh/dist ./packages/ssh/dist
# The built-in artifacts (ADR 0039): a script and its manifest each. The server checks every file against its manifest
# when it starts; `node apps/api/dist/admin.js artifacts` does the same from outside.
COPY --from=build /app/artifacts ./artifacts
COPY --from=build /app/apps/web/dist ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "apps/api/dist/healthcheck.js"]
CMD ["node", "apps/api/dist/main.js"]
