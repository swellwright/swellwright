# deploy/compose

Docker Compose files. The decisions are in [ADR 0019](../../docs/adr/0019-container-image-and-deployment.md); the design is `docs/en/design/09-ops-docker.md`.

| File | What it is |
| --- | --- |
| `docker-compose.yml` | Swellwright with PostgreSQL and Valkey, built from this checkout. For running it. |
| `.env.example` | The settings of that stack. Copy it to `.env`, fill in three secrets, and set proxy trust explicitly. |
| `docker-compose.dev.yml` | Only PostgreSQL and Valkey on `127.0.0.1`, for developing on the host. Not a deployment. |

## Run it

You need Docker with Compose v2 and a reverse proxy with TLS in front (see `deploy/nginx`).

```sh
cd deploy/compose
cp .env.example .env
# fill in POSTGRES_PASSWORD, SW_AUTH_KEY and SW_SETUP_TOKEN, then set SW_TRUSTED_PROXIES
docker compose up -d --build
```

The first build downloads and compiles everything and takes a few minutes. When it is up, the console is on `http://127.0.0.1:3100`; put the proxy in front of it and open it under your own name. The first visitor enters `SW_SETUP_TOKEN` and creates the owner; **remove the token from `.env` afterwards** (`docker compose up -d` applies it).

**Compose refuses to start with missing or empty `SW_TRUSTED_PROXIES`.** Behind a proxy, set it to the proxy's exact peer address as seen by the API, or an exclusive proxy CIDR. A proxy running on the Docker host may appear as the bridge gateway rather than loopback. Make the proxy overwrite the forwarded header (see `deploy/nginx`). Do not trust `uniquelocal`, a whole shared bridge, or the plugin network: sidecars reach the same API port. Set `false` only for direct access, such as the CI smoke stack. Behind a proxy with trust disabled, all clients share its source limits: five wrong passwords for the same account can delay a legitimate login even when every request carries a different forwarded address. The API warns once if it ignores `X-Forwarded-For` from a private peer.

What starts: `postgres`, `valkey`, then `migrate` (applies the database migrations and exits), then the server. The server container has a read-only file system, no capabilities and runs as a normal user; the database and the cache sit on a network nothing outside can reach; the only published port is the server's, on the loopback address.

The image can carry facts about its build for the console's "Build info" (`GET /api/v1/version`): the build arguments `SW_BUILD_TIME`, `SW_BUILD_NUMBER`, `SW_GIT_BRANCH` and `SW_GIT_COMMIT`, all optional (`docker build --build-arg SW_GIT_COMMIT="$(git rev-parse HEAD)" .`; with Compose, under `build.args`). Whatever is not given is shown as unknown. The server also asks `api.github.com` once a day for the newest release and the star count; `SW_UPDATE_CHECK=off` in `.env` stops that.

## When `binaries.prisma.sh` is not reachable

The build downloads the Prisma schema engine from `binaries.prisma.sh`. From some networks (a residential connection in Russia, for example) that host does not answer and the build stops with `ECONNRESET` or a timeout. Point the build at a mirror of it:

```sh
docker compose build --build-arg PRISMA_ENGINES_MIRROR=https://cdn.npmmirror.com/binaries/prisma
docker compose up -d
```

Any mirror that keeps the layout of `binaries.prisma.sh` works. The mirror is only a source: the downloaded engine is compared with the checksum pinned in `packages/db/engine-checksums.json`, and a different file fails the build.

## Keep these

- **`SW_AUTH_KEY`** seals the authenticator secrets in the database. Without it nobody can sign in with an authenticator and every user sets it up again. Keep a copy outside the server.
- **The `pgdata` volume** is the database. Back it up (`docker compose exec postgres pg_dump -U sw swellwright`), and test the restore.

## Everyday commands

```sh
docker compose ps                      # state and health of the services
docker compose logs -f swellwright     # the server log
docker compose up -d --build           # after pulling a new version: rebuilds, migrates, restarts
docker compose exec swellwright node apps/api/dist/admin.js users
docker compose exec swellwright node apps/api/dist/admin.js reset-credentials <login name>
```

The last two are the way back in when nobody can sign in (ADR 0016).

## Checking a deployment

`scripts/smoke-test.sh <url> <setup token>` runs the checks CI runs against a stack that is up. **It creates the owner**, so use it on a stack you are about to throw away.
