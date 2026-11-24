---
name: swellwright-validate
description: >-
  Use before running checks, opening a pull request, or merging in this
  repository. Operational detail for the commands in docs/en/development.md
  and AGENTS.md: how to read an intermittent CI failure, the hygiene secret, and
  the merge conventions this project's history actually follows.
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

## An intermittent CI failure is a finding — do not retry it away

There is no known flaky test left to rerun. Every intermittent failure this
project has seen had a cause in the code or in the test, and a loaded runner only
made it show more often:

- The step that ran twice (`does not start a step twice`): Ubuntu 25.10 and the
  current `ubuntu-latest` ship the Rust coreutils, whose `mkdir` tells both of
  two racing callers that it made the directory. Never use `mkdir` as a lock
  on a server (use an exclusive create such as `set -C`, or `flock`).
- A line of a run's output missing at the end: the step status measured the
  size of the output before it looked at the exit marker, and the reader stops at
  that size. A reading must decide the state first and measure after.
- A test that looks at the whole machine (`ps | grep sleep 60`): other test
  files and packages run beside it (turbo runs packages in parallel, and
  `node --test` runs files in parallel). A test checks the process it started.
- A timeout that also bounded something it should not (the pool's first
  connection).

So when a CI `build` job fails and the same code is green locally:

1. Read the job log before guessing: `gh run view <run-id> --job <job-id> --log`.
   When one package's test task fails, turbo stops the tasks still running, so a
   long list of `✖ dist/...` lines after the first failure is that abort, not dozens
   of independent breakages. Find the first failing assertion.
2. Read the assertion and ask what it assumes about time, order or the machine.
3. Reproduce it before changing anything: a throwaway branch named `diag/...` with
   a workflow that repeats the failing suite (half of the passes with the machine
   kept busy) shows whether it fails, and a test that forces the interleaving
   (a stand-in `mkdir` or `wc` that finishes the step at the awkward moment) shows
   why. Commit the test first and see it fail, then the fix. Delete the `diag/`
   branch; never merge it.
4. A single rerun (`gh run rerun <run-id> --failed`) is fine to see whether a
   failure repeats, but it does not close the matter, and a second failure is a
   signal to investigate, not to retry again. Never add a retry to the test
   itself, and do not widen a timeout without saying what it bounds.

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
