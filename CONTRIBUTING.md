# Contributing

Thank you for your interest. Swellwright is in the design phase, so the most useful contributions right now are design feedback, plugin ideas, documentation and translations.

## Developer Certificate of Origin

All contributions are accepted under the [Developer Certificate of Origin](DCO). Sign off every commit:

```bash
git commit -s -m "docs: clarify plugin permissions"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line. Use an address you are comfortable publishing (GitHub offers a `users.noreply.github.com` address).

## Workflow

1. Open an issue first for anything larger than a typo or small fix.
2. Fork, create a branch, make focused commits ([Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
3. Run `pnpm run check`, `python scripts/check-hygiene.py` and `bash scripts/check-dco.sh` locally.
4. Open a pull request using the template.

## Development setup

Codex and Claude Code share [AGENTS.md](AGENTS.md). See [development and validation](docs/en/development.md) and [current project status](docs/en/project-status.md).

You need Node.js 26 (see `.nvmrc`) and pnpm 10 (the exact version is in the `packageManager` field of `package.json`). Corepack is not bundled with Node.js 25 and later, so install pnpm explicitly (for example with `npm install --global pnpm@10.34.9`).

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check      # format, lint, typecheck, build and test every package
python scripts/check-hygiene.py
```

Run the first slice locally (Node.js 26 and Docker):

```bash
cp .env.example .env
docker compose -f deploy/compose/docker-compose.dev.yml up -d   # Postgres and Valkey on 127.0.0.1
pnpm run build
pnpm run db:migrate:deploy                # create the schema; /ready says not_ready until it is applied
pnpm --filter @swellwright/api dev        # http://127.0.0.1:3000/api/v1/ready
pnpm --filter @swellwright/web dev        # http://127.0.0.1:5173, proxies /api to the API
```

On a new database the API prints a one-time **setup token** to its log. Open the console, enter the token, create the owner and add the authenticator ([ADR 0014](docs/adr/0014-sign-in-with-password-and-authenticator.md)). Set `SW_AUTH_KEY` in `.env` (the comment in `.env.example` shows how to make one) so the authenticator keeps working after a restart.

The integration tests need the same database. Point `SW_TEST_DATABASE_URL` (and `SW_TEST_VALKEY_URL`) at the compose services after `db:migrate:deploy`; without them those tests are skipped, and CI always runs them. The sign-in tests make a schema of their own, so the database needs permission to create schemas. `SW_TEST_DATABASE_POOL=1` makes the tests use one connection each, for a server that cannot run transactions of several connections side by side.

### Changing the database schema

The schema is `packages/db/prisma/schema.prisma`, with committed SQL migrations next to it ([ADR 0013](docs/adr/0013-prisma-for-the-data-layer.md)).

1. Edit the schema and run `pnpm run db:migrate:dev -- --name what_changed` (needs the compose database). It writes a new directory under `packages/db/prisma/migrations/`.
2. Read the generated SQL and commit it together with the schema. Never edit or delete a migration that has been merged.
3. `pnpm run db:schema:check` fails when the schema and the migrations disagree; CI runs it.

Migration commands first check the Prisma schema engine binary against `packages/db/engine-checksums.json`. After upgrading Prisma, pin the new binaries as described in `packages/db/README.md`.

The workspace is `apps/*` and `packages/*` (pnpm workspaces plus Turborepo); the layout and the reasons are in [ADR 0009](docs/adr/0009-monorepo-and-tooling.md).

## Never commit real deployment data

No real domains, IP addresses, node names, tokens, passwords, SSH keys, `.env` files, backups or user data, not even in tests or screenshots. Use `example.com` and the documentation ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`. CI rejects secrets and personal e-mail addresses.

## Code and docs

- TypeScript (strict), ESLint, Prettier; Zod schemas are the single source for types and OpenAPI.
- Every public API change updates the OpenAPI document and reviews the `oasdiff` compatibility report (currently informational in CI).
- Documentation is English first (`docs/en/`); Russian translations are welcome in `docs/ru/`.
- Tests are required, including failure and rollback cases for anything that changes a server or the panel.

## Plugins

Plugins declare every permission they need in the manifest, never execute install scripts, and must not read anything beyond the secret kinds they declare. See [docs/en/plugins.md](docs/en/plugins.md). Community plugins are listed in `registry/index.json` through pull requests.

## Security

Do not open public issues for vulnerabilities; follow [SECURITY.md](SECURITY.md).

## Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
