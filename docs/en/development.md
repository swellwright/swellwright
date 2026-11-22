# Development with Codex and Claude Code

Both agents use `AGENTS.md`. Claude Code imports it from `CLAUDE.md`; its UI skill
entry point reads `.agents/skills/swellwright-ui/SKILL.md`, the canonical Codex skill.
Keep changes to shared instructions there, rather than maintaining two different policies.
Project status is in [project-status.md](project-status.md); accepted decisions are in `../adr/`.
The `@AGENTS.md` import also supports Claude versions that do not load AGENTS.md
directly; see [Claude's shared-file guidance](https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools).
Codex discovery is documented in [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [skills](https://learn.chatgpt.com/docs/build-skills).

## Clean setup

Use Node 26 and pnpm 10.34.9 (the authoritative pin is `package.json`). Corepack is
not assumed. Do not copy node_modules from another directory or machine: Windows
junctions can retain absolute targets. Reinstall dependencies after moving the repository.

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm run doctor
pnpm run check
pnpm run openapi:check
python scripts/check-hygiene.py
pnpm run artifacts:check
```

The doctor checks local prerequisites without contacting the panel or reading `.env`.
It does not install anything. On Windows, use PowerShell; `bash` from Git for Windows
can run DCO checks, but is not a replacement for the Linux SSH test environment.
Git's dubious-ownership error may need a `safe.directory` exception for this exact
trusted checkout (or `git -c safe.directory=<absolute-checkout> ...` for one command).
Never use `safe.directory=*`.

## Run the console

Copy `.env.example` to `.env` **in this repository**, populate a local `SW_AUTH_KEY`,
and start only the development services:

```text
docker compose -f deploy/compose/docker-compose.dev.yml up -d
pnpm run build
pnpm run db:migrate:deploy
pnpm --filter @swellwright/api dev
pnpm --filter @swellwright/web dev
```

API: `http://127.0.0.1:3000/api/v1/ready`; UI: `http://127.0.0.1:5173`.
Use the one-time setup token shown by this local API, create an owner and enroll TOTP.
Keep local setup tokens and authenticator material out of screenshots and commits.
Never copy a surrounding private administration `.env` into this repository.

For synthetic panel data use `pnpm --filter @swellwright/remnawave run fake-panel -- --port 8801`.
See `packages/remnawave/README.md` for the explicit loopback/HTTP development flags.
Live panel credentials are not required for normal development.

## Validation levels

| Level | Required environment | What it establishes |
| --- | --- | --- |
| Local static/unit | Node/pnpm and installed dependencies | Format, lint, typecheck, build, unit tests, generated contracts and artifact consistency |
| API/database integration | Disposable PostgreSQL and Valkey; `SW_TEST_DATABASE_URL`, `SW_TEST_VALKEY_URL`; migrations applied | Real database behavior, authentication and integration cases |
| SSH/shell | Linux POSIX tools; real sshd for integration suites | Detached processes, sudo, reconnect, cancellation and SFTP |
| Container | Docker/Compose | Image, migrations, health, smoke and container restrictions |
| UI | Running local API/web and browser | Interaction, layout, responsive widths and accessibility |

`pnpm run check` includes tests, but database and POSIX suites deliberately skip if
their prerequisites are absent. Report the skip counts; do not call that a full acceptance.
For database work also run `pnpm run db:schema:check`. For installer changes run
`pnpm run artifacts:test`, `sh -n`, `dash -n` and shellcheck as in CI. DCO is checked by
`bash scripts/check-dco.sh <base> HEAD` for the actual commit range.
The `api-compat` CI job currently reports oasdiff changes; it is not a blocking gate.
The broader tools listed in the design testing document are targets, not all installed gates.

## Optional connections

Neither GitHub MCP nor a live Remnawave MCP is required to build. Configure private
connections outside this public repository. Codex uses `[mcp_servers.NAME]` in its
trusted configuration; Claude Code uses `.mcp.json`. Never embed tokens in either.
Keep live read-only connections and local synthetic test servers clearly distinguished.
Do not copy another agent's sandbox, permission overrides or previous approvals.
