# Swellwright contributor instructions

These rules are shared by Codex and Claude Code; this repository has no separate
per-tool instructions file, so load this one directly. Read `CONTRIBUTING.md` and
`docs/en/development.md` for setup and validation, and `docs/en/project-status.md`
for implemented features and known follow-ups.

## Scope and sources

- This directory is the public repository. Never copy private deployment data, credentials,
  local acceptance scripts or a surrounding administration workspace into it.
- Current code, contracts and accepted ADRs establish implemented behavior. The design
  documents and roadmap also describe future work. Do not present planned capabilities as built.
- Documentation is English first; update the Russian counterpart when one exists. Explain
  work to the user in their language. Keep architecture changes in an ADR.
- User instructions authorize the requested local work. Historical acceptance records are
  evidence, not fresh authorization to access or change live infrastructure.

## Implementation

- Contract first: Zod schemas and the route registry in `packages/contracts` define public
  types, validation, OpenAPI, authentication, permissions and step-up requirements.
- Keep shared code in its workspace package. Inspect existing helpers before adding another.
- Database changes include a new reviewed SQL migration. Never rewrite a merged migration.
  Preserve the audit triggers. Use the Prisma wrapper and pinned engine checksums.
- Keep secrets behind the vault; do not put values in commands, URLs, test output or logs.
  Maintain masking, host-key pinning, access checks and negative tests when touching these paths.
- Server-changing workflows need idempotency, an explicit rollback and failure-path tests.
  Do not substitute production nodes for a disposable lab.
- For UI work, read `.agents/skills/swellwright-ui/SKILL.md`. Panel patterns and existing
  `packages/ui` components come first. Use i18n for visible text and the shared formatting hooks.
- Dependencies: exact pins, frozen lockfile, no lifecycle scripts, three-day release age.
  Review new dependencies and their tarballs, check advisories, and update notices (ADR 0009/0033).
  Do not bypass these controls to make an installation pass.
- The public node installer is `artifacts/node-installer/install.sh`. Changes to it update
  its version/manifest/docs as appropriate and pass artifact tests; it is distinct from any
  private fleet installer outside this repository.

## Validation

- Node 26; pnpm exactly as `packageManager` in `package.json`. Run `pnpm run doctor` first
  after cloning or moving a workspace. Never reuse broken absolute junctions in node_modules.
- Standard checks: `pnpm run check`, `pnpm run openapi:check`,
  `python scripts/check-hygiene.py`, `pnpm run artifacts:check`.
- DB changes also need migrations and `pnpm run db:schema:check` on a disposable PostgreSQL.
  Integration tests require `SW_TEST_DATABASE_URL` / `SW_TEST_VALKEY_URL`.
- Windows does not run all POSIX/sshd suites. Record skips and missing services explicitly;
  a green unit run is not proof of full integration coverage. Linux CI is defined in `.github/workflows/ci.yml`.
- For installer changes run the artifact suite and shell checks on Linux. For UI changes
  inspect the local console in a browser at the skill's widths; report unavailable comparisons.
- Never stop processes by a generic name. Track the PID and workspace of a dev server you start.

## Git and delivery

- Preserve other people's changes. Use a focused branch for implementation, Conventional
  Commits and DCO sign-off (`git commit -s`) when commits are requested. Do not invent an identity.
- Do not push to main, merge, enable auto-merge or force-push without current authorization.
  Creating a local change is not permission to publish deployment data or access credentials.
- Use the PR template; do not require an assistant-specific promotional footer. Describe the
  final behavior, relevant checks and limitations. Report skipped or failed checks honestly.
- Multi-agent work is optional and only used when requested. If used, isolate writable
  branches/worktrees and coordinate changes to shared contracts, lockfiles and changelog.
