# packages/db

The schema now also supports the phase-2 and phase-3 features listed in
[current project status](../../docs/en/project-status.md). The introductory model list below is historical;
`prisma/schema.prisma` and its migrations are authoritative for the current models.

The Prisma schema, the SQL migrations and the database client shared by the API and the worker. Decisions: [ADR 0013](../../docs/adr/0013-prisma-for-the-data-layer.md). Data model design: `docs/en/design/02-data-model.md`.

Status: `User`, `Credential` (password hash, sealed TOTP secret, lockout counters), `RecoveryCode`, `Session` (with `elevated_until` for step-up, [ADR 0017](../../docs/adr/0017-step-up-authentication.md)), `Invitation` (the one open invitation of a user, [ADR 0016](../../docs/adr/0016-users-invitations-and-credential-reset.md)) and `AuditEvent` (the append-only audit chain; its migration installs triggers that refuse update, delete and truncate, [ADR 0015](../../docs/adr/0015-permissions-and-the-audit-chain.md)). `VaultMeta` and `Secret` (the vault, [ADR 0018](../../docs/adr/0018-the-vault-key-hierarchy-and-its-first-slice.md); only ciphertext and wrapped keys are stored). Raw SQL in a test must name the schema of the isolated database (`isolated.schema`): the client qualifies its own queries, raw SQL is not.

`@swellwright/db/testing` makes a database of its own for a test file (a fresh schema with every migration applied); it is for tests only.

## Use

```ts
import { Database } from '@swellwright/db';

const db = new Database({ url: process.env.SW_DATABASE_URL });
await db.assertReady(); // the server answers and every shipped migration is applied
await db.client.user.findMany();
await db.close();
```

Create one `Database` per process and share it. `assertReady` rejects with a `DatabaseNotReadyError` whose `code` is `MIGRATIONS_PENDING` or `SCHEMA_AHEAD`; `/ready` of the API reports that code.

## Commands (from the repository root)

| Command                                    | What it does                                                          |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `pnpm run db:migrate:deploy`               | Applies the committed migrations (what production and CI run).        |
| `pnpm run db:migrate:dev -- --name <name>` | Creates a migration from a schema change (needs a database).          |
| `pnpm run db:status`                       | Shows which migrations are applied.                                   |
| `pnpm run db:schema:check`                 | Fails when the database built from the migrations differs from the schema. |
| `pnpm run db:generate`                     | Regenerates the client (the package build does it too).               |

All of them read `SW_DATABASE_URL` from the environment or from `.env` at the repository root.

## The schema engine and its pinned checksums

`migrate` runs a native binary, the Prisma schema engine. The Prisma CLI downloads it on first use, so `pnpm install --ignore-scripts` does not cover it. `scripts/prisma.mjs` therefore checks it against `engine-checksums.json` before any command that can run it, and deletes it on a mismatch.

After upgrading Prisma, pin the new binaries:

1. Take the engine commit from `@prisma/engines-version` (the part after the last dot of its version) and put it into `engine`.
2. For every platform in `sha256`, download `https://binaries.prisma.sh/all_commits/<commit>/<platform>/schema-engine.gz` (`schema-engine.exe.gz` for `windows`), unpack it and compute the SHA-256 of the unpacked file. The published `schema-engine.sha256` next to it must agree.
3. To add a platform, do the same for it. Its name is the part of `schema-engine-<platform>` the CLI puts into `node_modules/@prisma/engines`.
