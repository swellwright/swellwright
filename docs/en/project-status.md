# Project status

Baseline: `phase-3-complete`, commit `19cdee2`, 2026-11-22. This is a pre-alpha
implementation, not a production release. API description version: 0.31.0.

## Implemented

- Phase 1: API/web shell, password and TOTP, users/roles/sessions/tokens, step-up,
  audit, vault, i18n, container packaging, plugin discovery/approval/runtime,
  declarative drivers and sidecar gateway.
- Phase 2: server inventory, pinned SSH host keys, access/facts, detached command
  runs, scripts, SFTP and versioned installer artifacts.
- Phase 3: read-only Remnawave 3.4 client and browsers, snapshots/diff, conventions,
  reconciliation, impact calculation, read API console, baseline checks and dashboard.

Commands currently run through the API's command runner. `apps/worker`,
`packages/engine` and `packages/policy` are skeletons, not a complete durable workflow
system. CLI, probe agent, web terminal, panel writes and full deploy/rollback workflows
remain planned. Architecture diagrams describe the target system unless stated otherwise.

## Before phase 4

1. The intermittent SSH test failure `does not start a step twice` (two writes to the
   counter instead of one) is explained and fixed. Ubuntu 25.10 and the current
   `ubuntu-latest` runner ship the Rust coreutils (uutils), whose `mkdir` answers success
   to both of two callers that race for one path (measured: 344 of 600 and 173 of 600
   tight races). Both the launch (`mkdir "$D"`) and the wrapper (`mkdir .claimed`) used
   `mkdir` as the claim, so two launches both became the owner and both wrappers ran the
   script; the earlier `.claimed` fix could not help. The owner is now decided by an
   exclusive create done by the shell (`set -C`: none in 600). Two regression tests make
   `mkdir` untrustworthy on purpose. Servers that run Ubuntu 25.10 or later (nodes
   included) must never rely on `mkdir` as a lock; the node installer uses `flock`.
2. The SSH pool's acquire-timeout test was failing because `acquireTimeoutMs: 150`
   bounded establishing the *first* connection too, not just waiting for a busy one;
   a real handshake occasionally exceeds 150ms on a loaded shared CI runner. Raised to
   1000ms (held connection to 3000ms, same ratio) rather than retried away; reproduced
   4 times in a row before the fix, 0 since. The command-shell streaming test has not
   been independently investigated; do not assume the same cause without reproducing it.
3. Review `reconciliation.drift` warning severity for an empty inventory.
4. Make explicit decisions for workflow approval policies P-001 through P-016 and
   record phase-4 architecture in the next ADR. Follow-ups also include operator access
   to `panel:console`, restricted SSH admin keys and snapshot retention.
5. Verify deploy/resume/rollback with a disposable lab, independent fallback access,
   real PostgreSQL and fault injection. A PGlite development stand cannot establish
   correctness under concurrent PostgreSQL transactions.

This list records pending work; it does not authorize live fleet operations. Update it
when a finding is resolved. Historical ADRs remain records of the decisions at that time.
