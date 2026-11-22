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

1. Investigate the reported intermittent SSH test failure `does not start a step twice`
   (two writes to the counter instead of one). The wrapper has a `.claimed` directory;
   the historical report does not prove the cause. Reproduce under Linux and real sshd,
   checking concurrent launch, attachment and cleanup before changing retries or timeouts.
2. Investigate the pool acquire-timeout test and the command-shell streaming test.
   Preserve behavioral assertions; do not hide failures with blanket retries.
3. Review `reconciliation.drift` warning severity for an empty inventory.
4. Make explicit decisions for workflow approval policies P-001 through P-016 and
   record phase-4 architecture in the next ADR. Follow-ups also include operator access
   to `panel:console`, restricted SSH admin keys and snapshot retention.
5. Verify deploy/resume/rollback with a disposable lab, independent fallback access,
   real PostgreSQL and fault injection. A PGlite development stand cannot establish
   correctness under concurrent PostgreSQL transactions.

This list records pending work; it does not authorize live fleet operations. Update it
when a finding is resolved. Historical ADRs remain records of the decisions at that time.
