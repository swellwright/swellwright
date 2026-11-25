# Project status

Baseline: `phase-3-complete`, commit `19cdee2`, 2026-11-22. This is a pre-alpha
implementation, not a production release. API description version: 0.32.0.

## Implemented

- Phase 1: API/web shell, password and TOTP, users/roles/sessions/tokens, step-up,
  audit, vault, i18n, container packaging, plugin discovery/approval/runtime,
  declarative drivers and sidecar gateway.
- Phase 2: server inventory, pinned SSH host keys, access/facts, detached command
  runs, scripts, SFTP and versioned installer artifacts.
- Phase 3: read-only Remnawave 3.4 client and browsers, snapshots/diff, conventions,
  reconciliation, impact calculation, read API console, baseline checks and dashboard.

Commands currently run through the API's command runner. `apps/worker` and
`packages/policy` are skeletons; `packages/engine` holds the core and the loop of the engine,
and `apps/api` the store over PostgreSQL and the runner that starts the loop with the
application (see below), but the catalogue of workflows is empty: there is still no durable
workflow system for people.
CLI, probe agent, web terminal, panel writes and full deploy/rollback workflows remain
planned. Architecture diagrams describe the target system unless stated otherwise.

## Before phase 4

1. The engine core is decided: [ADR 0048](../adr/0048-engine-core.md), accepted on
   2026-11-25 (runs and locks in PostgreSQL only, a lease with a fence token, and the loop
   in the API process because the vault key lives there). Still open: policies P-001
   through P-016 get an ADR of their own before any code enforces approvals. Follow-ups
   also include operator access to `panel:console`, restricted SSH admin keys, snapshot
   retention and how a separate worker process would get secrets. Built so far: the pure
   core in `packages/engine`: the state tables of a run and of a step (the run diagram in
   `docs/en/architecture.md` is checked against the table by a test), resource locks in one
   fixed order, the lease and fence arithmetic, the plan with its approval hash, the order
   and the verdict of an undo, the recovery of an interrupted step and the step contract;
   and the loop (`Worker`) over a `RunStore` port with a store in memory and one over
   PostgreSQL (the tables `runs`, `run_steps`, `undo_records`, `run_events` and
   `resource_locks`, migration `20261125000000_create_runs`), both held to the same suite
   and the same scenarios: a worker killed at each point, a stalled worker, contested
   locks, cancel and pause; several loops on one server are tested in CI. The loop now runs
   inside the API process (`EngineRunner`: it starts with the application and stops
   before the database and the vault, a step in hand is asked to give up, and a run
   waits with `vault_sealed` while the vault is sealed); a run is made from a workflow
   and its parameters (`EngineRunsService`, no route yet, the catalogue of the build is
   empty). The slice was read in full by three reviewers before it was published and
   hardened (ADR 0048, "The review of the fourth slice"). Not built yet: the ports for SSH and the panel, undo execution, delivery of
   secret values to steps with the check of their output, and the lab acceptance on a
   real panel and real nodes.
2. Verify deploy/resume/rollback with a disposable lab, independent fallback access, real
   PostgreSQL and fault injection. A PGlite development stand cannot establish correctness
   under concurrent PostgreSQL transactions.

This list records pending work; it does not authorize live fleet operations. Update it
when a finding is resolved. Historical ADRs remain records of the decisions at that time.

## Found and fixed before phase 4

Every intermittent CI failure had a cause in the code or in the test; none was retried away.

- **A step that ran twice** (`does not start a step twice`). Ubuntu 25.10 and the current
  `ubuntu-latest` runner ship the Rust coreutils (uutils), whose `mkdir` answers success to
  both of two callers that race for one path (measured: 344 of 600 and 173 of 600 tight
  races). The launch and the wrapper used `mkdir` as the claim, so both became the owner.
  The owner is now decided by an exclusive create done by the shell (`set -C`: none in
  600). Servers that run Ubuntu 25.10 or later (nodes included) must never rely on `mkdir`
  as a lock; the node installer uses `flock`.
- **The last line of a run's output missing** (the command-shell streaming test). The step
  status measured the size of `out` and `err` before it looked at the exit marker, and the
  command runner reads no further than that size. A script that wrote its last line and
  ended between the two looks was reported as over with the size from before that line.
  The state is now decided first and the sizes measured after. A test makes `wc` end the
  step right after it has counted: it failed in CI (`6 !== 11`) before the fix.
- **The cancel test counted every `sleep 60` of the machine** (`ps | grep`). Other test
  files, and the SSH package that turbo runs beside them, run `sleep 60` of their own. The
  script now says the pid of its sleeper and the test waits for that process; a
  `sleep 60` that belongs to nobody there is left running next to it. Whether this caused
  the one failure seen on 22 November was not proven (12 repeats of the whole test run, six
  of them with the machine kept busy, did not reproduce it); the dependence is removed.
- **The SSH pool's acquire-timeout test**: `acquireTimeoutMs: 150` bounded establishing
  the *first* connection too, not just waiting for a busy one; a real handshake
  occasionally exceeds 150ms on a loaded shared CI runner. Raised to 1000ms (held
  connection to 3000ms, same ratio) rather than retried away.
- **`reconciliation.drift` on an empty inventory** was a warning ("13 differences") on a
  new installation, where every node of the panel is simply not in the inventory yet. While
  that is the only difference it is now `info`; any other difference, or an inventory with
  even one server, keeps the warning.
- **Sign-in, tokens and contract (review of 2026-11-25, first part).** The "last owner"
  rule counts only active owners with a confirmed authenticator, also for a credential
  reset from the console (the host command stays the way back in). A credential reset,
  a password change and disabling an account revoke the user's live API tokens in the
  same transaction (`tokens_revoked` in the audit record; enabling the account again does
  not bring them back), and token issuance re-reads the session, the role and the
  elevation under a per-account PostgreSQL lock, so the quota of 20 holds under
  concurrency. A token's address list compares an address only with ranges of its own
  family (`::/0` no longer admits IPv4). `Authorization: Basic` from a proxy no longer
  breaks the routes that take a session or a token, and a handler without a route of the
  registry is refused with 500 instead of being public. A body that cannot be read is
  answered with a fixed envelope that carries the request id. A chosen password is
  counted after NFKC normalization. An audit export ends at the head of its first page
  (`through`), the offline checkpoint lookup no longer depends on the order of the JSON
  members, and the Valkey readiness probe closes its own connection when it times out.
  The OpenAPI document marks fields with a default as optional in requests, declares the
  sidecar gateway's token and the JSON type of a snapshot export, and a script run can
  name the revision the person confirmed (`expectedScriptRevision`). Still open from the
  same review: a separate password throttle and second-factor lockout and a credential
  epoch for browser sessions (a later change), and the one-time rotation of API tokens
  issued before this change (an owner decision).
