---
name: swellwright-validate
description: >-
  Use before running checks, opening a pull request, or merging in this
  repository. Operational detail for the commands in docs/en/development.md
  and AGENTS.md: known CI flakiness, the hygiene secret, and the merge
  conventions this project's history actually follows.
---

# Validating and shipping a change in Swellwright

`AGENTS.md` and `docs/en/development.md` are authoritative for what to run and
why. This skill is the operational detail for running it and reading the
result, so a routine PR does not need a fresh investigation each time.

## Before pushing

Run, in this order, through the pinned toolchain (`pnpm run doctor` first on a
fresh or moved checkout):

```text
pnpm run doctor
pnpm run check          # format, lint, typecheck, build, test (turbo caches unaffected packages)
pnpm run openapi:check
python scripts/check-hygiene.py
pnpm run artifacts:check
```

For a schema change also run `pnpm run db:schema:check` against a disposable
PostgreSQL. `pnpm run check`'s test step skips the database/Valkey and
POSIX/sshd suites when their services are absent (reported as `# SKIP`); that
is not the same as them passing. CI has those services and runs them for real,
so a change that only touches those paths still needs a report of what was
and was not exercised locally.

## Known CI flakiness — do not "fix" it by retrying inside the test

The SSH pool's acquire-timeout test (`gives up waiting for a free connection
after the acquire timeout, and recovers`) can time out under a loaded CI
runner; it is tracked as a real, unresolved issue in
`docs/en/project-status.md` ("before phase 4"), not something to paper over.
If a CI `build`/`test` job fails and the log shows exactly this one assertion
failing, with everything else (including the same job locally) green:

1. Read the job log before assuming it is this one: `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs --allow-escape-sequences`.
2. `node --test --test-concurrency=1` stops the remaining test files once one fails, so a long list of `✖ dist/...` lines after it is that abort, not dozens of independent breakages.
3. One rerun of the failed job (`gh run rerun <run-id> --failed`) is reasonable for this specific, already-documented flake. Do not loop retries, and do not rerun past a second failure without saying so — a second failure in the same run is a signal to investigate, not to retry again.
4. Any other failing test is a real failure: do not rerun it away.

## The hygiene secret (`SW_FORBIDDEN_PATTERNS`)

CI's `hygiene` job runs `scripts/check-hygiene.py` with a repository secret,
`SW_FORBIDDEN_PATTERNS` (wired in `.github/workflows/ci.yml`), in addition to
the checks the script runs on its own (secret-looking strings, forbidden file
types, oversized files, stray personal e-mail addresses). The secret's own
patterns are not visible locally or anywhere in this repository, so a line
that looks completely harmless can still fail only in CI, and a local
`check-hygiene.py` run passing proves nothing about that secret.

If `hygiene` fails: read the job log for the exact `file:line` matches rather
than guessing, fix only what is named, and re-run. If the same literal string
keeps getting flagged across unrelated lines, treat that as an intentional
project rule (not a bug in the check) and ask the repository owner before
reintroducing it, rather than editing or working around the secret.

## Git and PR conventions this repository's history actually follows

- Conventional Commits; every commit signed off (`git commit -s`).
  `bash scripts/check-dco.sh <base> HEAD` verifies a range locally before pushing.
- Branch from current `main`; this repository's merged history is squash-merge
  with branch deletion (`gh pr merge --squash --delete-branch`), so normally
  only `main` and branches with real, currently pending work exist. If you find
  other stale branches, verify with `git diff --diff-filter=A --name-only
  main...<branch>` whether every file the branch adds already exists on
  `main` before assuming it is safe to delete — that is evidence of an
  already-merged (and possibly renamed) predecessor, not proof by itself.
- Fill the PR template's checklist truthfully; tick only what you actually ran.
- Never merge with a failing or still-pending required check. Never force-push,
  rewrite a shared commit, or merge/push without the repository owner's
  current, request-scoped authorization — an earlier approval for one change
  does not extend to a later, different one.
